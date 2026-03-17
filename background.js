const CACHE_EXPIRY = 1000 * 60 * 60 * 24 * 14;
const DEFAULT_SETTINGS = { 
    theme: 'system', 
    fontFamily: 'geist', 
    textSize: 'normal', 
    popupSize: 'standard', 
    dynamicBg: true, 
    useCache: true,
    stickyHeader: true,
    showSupport: true,
    showDownload: false
};

const GENIUS_CREDS = [
    { id: 'bOlTu9Nd4NKoyOS_CXg_G4skWiY6mb-KaVcRflmDnVyP39UgOnnMuahaZGHPNZ3u', secret: 'U2Rr5TXmKAQZWSsNAG_IV500XFgG7Rt7D6mbRblys9x1zXR0K9kN5qTp14atXcUSMOGmyKdC66C0NnCTbudTyQ' },
    { id: '1ulr-byVd9SFalwIv1EfI7yCEcTxArou3mXJhjn5874aXF3S9Bcl2I78vgMx25sb', secret: 'llC6f6fd3AiN_MSlQbB7W0-p7fnMs_m9KktX9rwNY0wOdvg4xpH47KISjmV8cLFruxUNZaEkOW_DQN5DNzuE4w' }
];

chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
        chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
        chrome.tabs.create({ url: 'welcome.html' });
    }
});

async function fetchWithTimeout(resource, options = {}) {
    const { timeout = 4000 } = options;
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(resource, { ...options, signal: controller.signal });
        clearTimeout(id);
        return response;
    } catch (error) {
        clearTimeout(id);
        throw error;
    }
}

async function getCached(key) {
    return new Promise(resolve => {
        chrome.storage.local.get(['settings', key], (res) => {
            const settings = res.settings || DEFAULT_SETTINGS;
            if (!settings.useCache) return resolve(null);
            if (res[key] && (Date.now() - res[key].timestamp < CACHE_EXPIRY)) resolve(res[key].data);
            else resolve(null);
        });
    });
}

async function setCached(key, data) {
    const payload = { [key]: { data, timestamp: Date.now() } };

    // For lyrics cache, enforce a hard cap of 10 recent songs to avoid unbounded growth
    if (key.startsWith('lyrics_')) {
        return new Promise(resolve => {
            chrome.storage.local.get(['lyrics_cache_index'], (res) => {
                let index = Array.isArray(res.lyrics_cache_index) ? res.lyrics_cache_index.slice() : [];

                // Move this key to the front (most recent)
                index = index.filter(k => k !== key);
                index.unshift(key);

                const MAX_LYRICS_CACHE = 10;
                let toEvict = [];
                if (index.length > MAX_LYRICS_CACHE) {
                    toEvict = index.slice(MAX_LYRICS_CACHE);
                    index = index.slice(0, MAX_LYRICS_CACHE);
                }

                payload['lyrics_cache_index'] = index;

                const finish = () => chrome.storage.local.set(payload, resolve);

                if (toEvict.length > 0) {
                    chrome.storage.local.remove(toEvict, finish);
                } else {
                    finish();
                }
            });
        });
    }

    // Non-lyrics cache behaves as before
    return new Promise(resolve => chrome.storage.local.set(payload, resolve));
}

// -----------------------------
// Parsing & Normalization Core
// -----------------------------

// Lightweight Jaro-Winkler implementation for uploader/title comparison
function jaroWinkler(s1, s2) {
    if (!s1 || !s2) return 0;
    s1 = s1.toLowerCase();
    s2 = s2.toLowerCase();
    const maxDist = Math.floor(Math.max(s1.length, s2.length) / 2) - 1;
    const match1 = new Array(s1.length).fill(false);
    const match2 = new Array(s2.length).fill(false);

    let matches = 0;
    for (let i = 0; i < s1.length; i++) {
        const start = Math.max(0, i - maxDist);
        const end = Math.min(s2.length - 1, i + maxDist);
        for (let j = start; j <= end; j++) {
            if (match2[j] || s1[i] !== s2[j]) continue;
            match1[i] = true;
            match2[j] = true;
            matches++;
            break;
        }
    }
    if (!matches) return 0;

    let t = 0;
    let k = 0;
    for (let i = 0; i < s1.length; i++) {
        if (!match1[i]) continue;
        while (!match2[k]) k++;
        if (s1[i] !== s2[k]) t++;
        k++;
    }
    t /= 2;

    const jaro = (matches / s1.length + matches / s2.length + (matches - t) / matches) / 3;
    // Winkler prefix scaling
    let l = 0;
    const maxPrefix = 4;
    for (; l < maxPrefix && l < s1.length && l < s2.length && s1[l] === s2[l]; l++);
    const p = 0.1;
    return jaro + l * p * (1 - jaro);
}

function normalizeUnicode(text) {
    try {
        return text.normalize('NFKC');
    } catch {
        return text;
    }
}

// Strip emojis and pictographic glyphs
function stripEmojis(text) {
    return text.replace(/\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu, '');
}

// Extract bracketed content and decide what to keep / drop
function stripBracketArtifacts(title, contextArray) {
    const discardRe = /(official|video|audio|lyric|visualizer|mv|hd|4k|1080p|remastered|explicit|clean|radio\s+edit|topic|auto-generated|soundtrack)/i;
    const retainRe = /(feat\.?|ft\.?|featuring|w\/|prod\.?|remix|cover|acoustic)/i;

    return title.replace(/[\(\[\{【]([^()\[\]\{\}【】]+)[\)\]\}】]/g, (m, inner) => {
        if (discardRe.test(inner)) return '';
        if (retainRe.test(inner)) {
            contextArray.push(inner.trim());
            return '';
        }
        return m;
    });
}

function basicFinalize(str) {
    return str.toLowerCase().replace(/[^\w\s']/g, '').replace(/\s+/g, ' ').trim();
}

// Levenshtein distance + normalized similarity
function levenshtein(a, b) {
    if (a === b) return 0;
    const al = a.length, bl = b.length;
    if (!al) return bl;
    if (!bl) return al;
    const dp = Array.from({ length: al + 1 }, () => new Array(bl + 1).fill(0));
    for (let i = 0; i <= al; i++) dp[i][0] = i;
    for (let j = 0; j <= bl; j++) dp[0][j] = j;
    for (let i = 1; i <= al; i++) {
        for (let j = 1; j <= bl; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            dp[i][j] = Math.min(
                dp[i - 1][j] + 1,
                dp[i][j - 1] + 1,
                dp[i - 1][j - 1] + cost
            );
        }
    }
    return dp[al][bl];
}

function diceCoefficient(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;
    const bigrams = new Map();
    for (let i = 0; i < a.length - 1; i++) {
        const gram = a.slice(i, i + 2);
        bigrams.set(gram, (bigrams.get(gram) || 0) + 1);
    }
    let matches = 0;
    for (let i = 0; i < b.length - 1; i++) {
        const gram = b.slice(i, i + 2);
        const count = bigrams.get(gram) || 0;
        if (count > 0) {
            bigrams.set(gram, count - 1);
            matches++;
        }
    }
    return (2 * matches) / (a.length + b.length - 2);
}

function parseTitle(rawTitle, uploaderName) {
    if (!rawTitle) return { artist: "", song: "", query: "" };

    // Phase 1: Lexical Normalization
    let title = normalizeUnicode(rawTitle);
    title = stripEmojis(title);
    title = title.replace(/^\(\d+\)\s*/, ''); // leading "(3) " notification

    const contextArray = [];
    title = stripBracketArtifacts(title, contextArray);

    // Phase 2: Structural Tokenization
    const isTopic = uploaderName && / - Topic$/i.test(uploaderName);
    if (isTopic) {
        const artistFromTopic = uploaderName.replace(/ - Topic$/i, '').trim();
        return {
            artist: basicFinalize(artistFromTopic),
            song: basicFinalize(title),
            query: encodeURIComponent(`${artistFromTopic} ${title}`.trim())
        };
    }

    // Normalize separators
    title = title.replace(/[–—]/g, '-');
    const separators = [' - ', ' ~ ', ' | ', ' // ', ' : ', '-'];
    let artist = "";
    let song = "";
    let splitSuccess = false;

    for (const sep of separators) {
        if (title.includes(sep)) {
            const parts = title.split(sep);
            const left = parts[0].trim();
            const right = parts.slice(1).join(sep).trim();
            // Uploader cross-referencing (solve A/B side)
            let useLeftAsArtist = true;
            if (uploaderName) {
                const cleanUploader = uploaderName.replace(/VEVO/i, '').trim();
                const score = jaroWinkler(left, cleanUploader);
                if (score < 0.85) {
                    // if left not close to uploader, try right
                    const rightScore = jaroWinkler(right, cleanUploader);
                    useLeftAsArtist = rightScore <= score;
                }
            }
            if (useLeftAsArtist) {
                artist = left;
                song = right;
            } else {
                artist = right;
                song = left;
            }
            splitSuccess = true;
            break;
        }
    }

    // Fallback: "Song by Artist" or Uploader name logic
    if (!splitSuccess) {
        const byMatch = title.match(/(.*)\s+by\s+(.*)/i);
        if (byMatch) {
            song = byMatch[1].trim();
            artist = byMatch[2].trim();
        } else {
            artist = uploaderName ? uploaderName.replace(/ - Topic/i, '').replace(/VEVO/i, '').trim() : "";
            song = title.trim();
        }
    }

    // Phase 3: Semantic Entity Resolution
    // 4.1 Feature Extraction
    const features = [];
    const featureRe = /(feat\.?|ft\.?|featuring|w\/)\s+([^()\-|]+)/ig;
    song = song.replace(featureRe, (_, _kw, who) => {
        features.push(who.trim());
        return '';
    }).trim();

    // 4.2 Remix / Cover handling
    const remixMatch = song.match(/(.+)\s+(\w+)\s+Remix$/i);
    if (remixMatch) {
        const base = remixMatch[1].trim();
        const remixer = remixMatch[2].trim();
        if (remixer && !artist.toLowerCase().includes(remixer.toLowerCase())) {
            artist = `${artist} ${remixer}`.trim();
        }
        song = `${base} Remix`;
    }

    // Final normalization for artist/song
    const fArtist = basicFinalize(artist);
    const fSong = basicFinalize(song);

    // Phase 4: Query Generation & Sanitization
    const baseQuery = (fArtist && fSong && !fSong.includes(fArtist))
        ? `${fArtist} ${fSong}`
        : (fSong || fArtist);

    let query = baseQuery || '';
    // Retry strategy with features if first pass fails is handled in fetchLyrics metadata/lyrics fallbacks.

    return {
        artist: fArtist,
        song: fSong,
        query: query.trim()
    };
}

// Algorithmic verification guardrails using Dice + Levenshtein
function isStrictMatch(parsedSong, apiSong) {
    if (!parsedSong || !apiSong) return true;
    const p = basicFinalize(parsedSong).replace(/[^a-z0-9]/g, '');
    const a = basicFinalize(apiSong).replace(/[^a-z0-9]/g, '');
    if (!p || !a) return true;

    // Anti-instrumental guard
    const intentHasInstrumental = /(instrumental|karaoke|beat)/i.test(parsedSong);
    const apiIsInstrumental = /(instrumental|karaoke|beat)/i.test(apiSong);
    if (!intentHasInstrumental && apiIsInstrumental) return false;

    // Sørensen–Dice coefficient (bi-gram overlap)
    const dice = diceCoefficient(p, a);
    if (dice < 0.65) return false;

    // Levenshtein length guard
    const dist = levenshtein(p, a);
    const maxLen = Math.max(p.length, a.length);
    const sim = 1 - dist / maxLen;

    if (p.length < 6 || a.length < 6) {
        // ultra short titles must be exact-ish
        return dist === 0;
    }

    return sim > 0.75;
}

async function fetchMetadata(parsed, rawArtistHint) {
    if (!parsed.query) return null;
    const cacheKey = `meta_${parsed.query}`;
    const cached = await getCached(cacheKey);
    if (cached) return cached;

    const attemptFetch = async (searchTerm) => {
        try {
            // Increase limit slightly to find the right match
            const res = await fetchWithTimeout(`https://itunes.apple.com/search?term=${encodeURIComponent(searchTerm)}&media=music&entity=song&limit=5`, { timeout: 3000 });
            if (!res.ok) return null;
            const data = await res.json();
            if (data.results && data.results.length > 0) {
                // Prefer results whose title matches strictly AND whose artist resembles our parsed/uploader artist
                const baseArtist = parsed.artist || basicFinalize(rawArtistHint || '');
                let best = null;
                for (const result of data.results) {
                    if (!isStrictMatch(parsed.song, result.trackName)) continue;
                    if (baseArtist) {
                        const candidateArtist = basicFinalize(result.artistName || '');
                        const artistDice = diceCoefficient(baseArtist, candidateArtist);
                        if (artistDice < 0.5) continue;
                    }
                    best = result;
                    break;
                }
                if (!best) {
                    // As a fallback, accept the first title-strict match even if artist is a bit off
                    best = data.results.find(r => isStrictMatch(parsed.song, r.trackName)) || null;
                }
                if (best) {
                    return { 
                        coverArt: best.artworkUrl100 ? best.artworkUrl100.replace('100x100bb', '500x500bb') : 'algorithmic', 
                        artistName: best.artistName, 
                        trackName: best.trackName,
                        source: 'iTunes'
                    };
                }
            }
        } catch (e) { console.warn("Meta fetch fail"); }
        return null;
    };
    
    let meta = await attemptFetch(parsed.query);
    if (!meta && parsed.song) meta = await attemptFetch(parsed.song);
    if (meta) await setCached(cacheKey, meta);
    return meta;
}

async function fetchLyrics(parsed) {
    if (!parsed.query) return { lyrics: null, error: "Invalid title detected.", source: null };
    const cacheKey = `lyrics_${parsed.query}`;
    const cached = await getCached(cacheKey);
    if (cached) return { lyrics: cached.lyrics, source: cached.source, error: null };

    const apis = [
        async () => { 
            const res = await fetchWithTimeout(`https://lrclib.net/api/search?q=${encodeURIComponent(parsed.query)}`, {timeout: 4000});
            if (!res.ok) throw new Error("LRCLIB failed");
            const data = await res.json();
            if (data && data.length > 0) {
                const bestMatch = data.find(t => isStrictMatch(parsed.song, t.trackName));
                if (bestMatch && bestMatch.plainLyrics) {
                    return { 
                        text: bestMatch.plainLyrics, 
                        source: 'LRCLIB',
                        metaTrack: bestMatch.trackName,
                        metaArtist: bestMatch.artistName || bestMatch.artist
                    };
                }
                if (isStrictMatch(parsed.song, data[0].trackName) && data[0].plainLyrics) {
                    const first = data[0];
                    return { 
                        text: first.plainLyrics, 
                        source: 'LRCLIB',
                        metaTrack: first.trackName,
                        metaArtist: first.artistName || first.artist
                    };
                }
            }
            throw new Error("LRCLIB Not found or strict match failed");
        },
        async () => {
             // Genius API + HTML Scraping
             const cred = GENIUS_CREDS[Math.floor(Math.random() * GENIUS_CREDS.length)];
             
             // 1. Get Token
             const tokenRes = await fetchWithTimeout('https://api.genius.com/oauth/token', {
                 method: 'POST',
                 headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                 body: `client_id=${cred.id}&client_secret=${cred.secret}&grant_type=client_credentials`,
                 timeout: 4000
             });
             if (!tokenRes.ok) throw new Error("Genius Token failed");
             const tokenData = await tokenRes.json();
             const token = tokenData.access_token;

             // 2. Search
             const searchRes = await fetchWithTimeout(`https://api.genius.com/search?q=${encodeURIComponent(parsed.query)}`, {
                 headers: { 'Authorization': `Bearer ${token}` },
                 timeout: 4000
             });
             if (!searchRes.ok) throw new Error("Genius Search failed");
             const searchData = await searchRes.json();
             
             if (!searchData.response || !searchData.response.hits || searchData.response.hits.length === 0) {
                 throw new Error("Genius Search found no hits");
             }

             // Find best match
             let bestHit = searchData.response.hits.find(h => h.type === 'song' && isStrictMatch(parsed.song, h.result.title));
             if (!bestHit) bestHit = searchData.response.hits[0]; // fallback to first hit if no strict match
             
             if (!bestHit || !bestHit.result || !bestHit.result.url) throw new Error("Genius No valid hit url");

             // 3. Scrape HTML
             const htmlRes = await fetchWithTimeout(bestHit.result.url, { timeout: 5000 });
             if (!htmlRes.ok) throw new Error("Genius HTML fetch failed");
             const html = await htmlRes.text();

             // Extract lyrics from HTML. Genius usually puts them in data-lyrics-container or Lyrics__Root
             let lyricsHTML = '';
             let chunks = html.split('data-lyrics-container="true"');
             
             if (chunks.length > 1) {
                 for (let i = 1; i < chunks.length; i++) {
                     let chunk = chunks[i];
                     let depth = 1;
                     let endIndex = 0;
                     for (let j = chunk.indexOf('>'); j < chunk.length; j++) {
                         if (chunk.substr(j, 4) === '<div') { depth++; }
                         else if (chunk.substr(j, 5) === '</div') {
                             depth--;
                             if (depth === 0) { endIndex = j; break; }
                         }
                     }
                     if (endIndex > 0) {
                         lyricsHTML += chunk.substring(chunk.indexOf('>') + 1, endIndex) + '<br/>';
                     }
                 }
             } else {
                 chunks = html.split('class="Lyrics__Container-');
                 for (let i = 1; i < chunks.length; i++) {
                     let chunk = chunks[i];
                     let depth = 1;
                     let endIndex = 0;
                     for (let j = chunk.indexOf('>'); j < chunk.length; j++) {
                         if (chunk.substr(j, 4) === '<div') { depth++; }
                         else if (chunk.substr(j, 5) === '</div') {
                             depth--;
                             if (depth === 0) { endIndex = j; break; }
                         }
                     }
                     if (endIndex > 0) {
                         lyricsHTML += chunk.substring(chunk.indexOf('>') + 1, endIndex) + '<br/>';
                     }
                 }
             }

             if (!lyricsHTML) throw new Error("Genius failed to extract lyrics from HTML");

             // Clean up HTML to plain text
             let cleanLyrics = lyricsHTML
                 .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '') // Strip script blocks
                 .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '') // Strip style blocks
                 .replace(/<br\s*\/?>/gi, '\n') // Replace <br> with newlines
                 .replace(/<(?!\/?(?:br|p|div|span|i|b|strong|em)(?=>|\s.*>))\/?.*?>/gi, '') // Remove most tags, keeping structural ones initially to avoid squishing
                 .replace(/<[^>]*>/g, '') // remove remaining tags
                 .replace(/&amp;/g, '&')
                 .replace(/&#x27;/g, "'")
                 .replace(/&quot;/g, '"')
                 .replace(/&lt;/g, '<')
                 .replace(/&gt;/g, '>')
                 .replace(/&#39;/g, "'")
                 .replace(/\n{3,}/g, '\n\n') // Normalize multiple newlines to max 2
                 .trim();

            // Strip the explicit contributors / title header sometimes placed by Genius
            // Handles variants like:
            // "1 Contributor"
            // "3 Contributors"
            // "I Swear Lyrics"
            // or "1 Contributor I Swear Lyrics"
            cleanLyrics = cleanLyrics.replace(
                /^(?:\s*\d+\s*Contributor(?:s)?[^\n]*\n)?\s*(?:[^\n]*Lyrics[^\n]*\n)?/i,
                ''
            ).trim();

             if (cleanLyrics) {
                 return { text: cleanLyrics, source: 'Genius' };
             }
             
             throw new Error("Genius extraction resulted in empty string");
        },
        async () => {
            const searchQuery = encodeURIComponent(parsed.song) + '/' + encodeURIComponent(parsed.artist || '');
            const res = await fetchWithTimeout(`https://lyrist.vercel.app/api/${searchQuery}`, {timeout: 4000});
            if (!res.ok) throw new Error("Lyrist failed");
            const data = await res.json();
            if (data && data.lyrics) {
                if (data.title && !isStrictMatch(parsed.song, data.title)) throw new Error("Lyrist strict match failed");
                return { text: data.lyrics, source: 'Genius via Lyrist' };
            }
            throw new Error("Lyrist Not found");
        },
        async () => {
            if (!parsed.song || !parsed.artist) throw new Error("OVH needs split");
            const res = await fetchWithTimeout(`https://api.lyrics.ovh/v1/${encodeURIComponent(parsed.artist)}/${encodeURIComponent(parsed.song)}`, {timeout: 4000});
            if (!res.ok) throw new Error("OVH failed");
            const data = await res.json();
            if (data && data.lyrics) return { text: data.lyrics, source: 'Lyrics.ovh' };
            throw new Error("OVH Not found");
        },
        async () => {
            const res = await fetchWithTimeout(`https://some-random-api.com/lyrics?title=${encodeURIComponent(parsed.query)}`, {timeout: 4000});
            if (!res.ok) throw new Error("SomeRandomAPI failed");
            const data = await res.json();
            if (data && data.lyrics) {
                if (data.title && !isStrictMatch(parsed.song, data.title)) throw new Error("SRA strict match failed");
                return { text: data.lyrics, source: 'SomeRandomAPI' };
            }
            throw new Error("SomeRandomAPI Not found");
        },
        async () => {
            if (!parsed.song || !parsed.artist) throw new Error("ChartLyrics needs split");
            const res = await fetchWithTimeout(`https://api.chartlyrics.com/apiv1.asmx/SearchLyricDirect?artist=${encodeURIComponent(parsed.artist)}&song=${encodeURIComponent(parsed.song)}`, {timeout: 4000});
            if (!res.ok) throw new Error("ChartLyrics failed");
            const text = await res.text();
            if (!text || text.includes('<string xmlns="http://chartlyrics.com/"></string>')) throw new Error("ChartLyrics empty");
            const parser = new DOMParser();
            const xml = parser.parseFromString(text, 'text/xml');
            const lyricText = xml.querySelector('Lyric')?.textContent;
            const lyricArtist = xml.querySelector('LyricArtist')?.textContent;
            const lyricSong = xml.querySelector('LyricSong')?.textContent;
            if (lyricText && lyricText.trim().length > 50) {
                if (lyricSong && !isStrictMatch(parsed.song, lyricSong)) throw new Error("ChartLyrics strict match failed");
                return { text: lyricText.trim(), source: 'ChartLyrics' };
            }
            throw new Error("ChartLyrics Not found");
        },
        async () => {
            if (!parsed.song || !parsed.artist) throw new Error("LyricsAPI needs split");
            const res = await fetchWithTimeout(`https://api.lyrics.plus/v1/lyrics?artist=${encodeURIComponent(parsed.artist)}&song=${encodeURIComponent(parsed.song)}`, {timeout: 4000});
            if (!res.ok) throw new Error("LyricsAPI failed");
            const data = await res.json();
            if (data && data.lyrics && data.lyrics.trim().length > 50) {
                if (data.title && !isStrictMatch(parsed.song, data.title)) throw new Error("LyricsAPI strict match failed");
                return { text: data.lyrics.trim(), source: 'LyricsAPI' };
            }
            throw new Error("LyricsAPI Not found");
        },
        // NOTE:
        // The following providers were removed because their servers do not send
        // CORS headers that allow chrome-extension origins, causing noisy
        // "No 'Access-Control-Allow-Origin'" failures in the console:
        // - https://lyrics-api.vercel.app
        // - https://www.lyricsmania.com
        // - https://www.azlyrics.com
        // - https://lyrics-api-eta.vercel.app
        //
        // If we reintroduce them in the future, they must be accessed via a
        // proper server-side proxy that adds CORS headers, not directly from
        // the extension runtime.
    ];

    for (let i = 0; i < apis.length; i++) {
        try {
            const result = await apis[i]();
            if (result && result.text) {
                await setCached(cacheKey, { lyrics: result.text, source: result.source });
                return { lyrics: result.text, source: result.source, error: null };
            }
        } catch (e) { console.warn(`API ${i+1} skipped:`, e.message); }
    }
    return { lyrics: null, source: null, error: "Please don’t hate us sadface <br>Lyrics could not be found for this track." };
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "fetchSongData") {
        const isManual = !!request.manualQuery;
        const parsed = isManual ? { query: request.manualQuery, artist: "", song: request.manualQuery } : parseTitle(request.title, request.uploader);
        
        (async () => {
            try {
                const [metadata, lyricsData] = await Promise.all([fetchMetadata(parsed, request.uploader), fetchLyrics(parsed)]);
                // Fallback cover art using YouTube thumbnail if API metadata is missing and we have a videoId
                let finalMetadata = metadata;

                // If LRCLIB returned authoritative artist/title, prefer those for display
                const lrclibTrack = lyricsData && lyricsData.metaTrack;
                const lrclibArtist = lyricsData && lyricsData.metaArtist;

                if (!finalMetadata) {
                    const baseTrack = lrclibTrack || parsed.song || (isManual ? request.manualQuery : request.title);
                    const baseArtist = lrclibArtist || parsed.artist || (isManual ? "Search" : request.uploader);
                    let coverArt = 'algorithmic';
                    if (request.videoId) {
                        coverArt = `https://i.ytimg.com/vi/${request.videoId}/hqdefault.jpg`;
                    }
                    finalMetadata = { trackName: baseTrack, artistName: baseArtist, coverArt };
                } else {
                    // If iTunes metadata artist is clearly off vs LRCLIB or parsed/uploader, snap it back
                    if (lrclibArtist) {
                        const metaArtistNorm = basicFinalize(finalMetadata.artistName || '');
                        const lrclibNorm = basicFinalize(lrclibArtist || '');
                        if (diceCoefficient(metaArtistNorm, lrclibNorm) < 0.5) {
                            finalMetadata.artistName = lrclibArtist;
                        }
                    } else if (parsed.artist || request.uploader) {
                        const metaArtistNorm = basicFinalize(finalMetadata.artistName || '');
                        const hintNorm = basicFinalize(parsed.artist || request.uploader || '');
                        if (diceCoefficient(metaArtistNorm, hintNorm) < 0.4) {
                            finalMetadata.artistName = parsed.artist || request.uploader;
                        }
                    }

                    if (finalMetadata.coverArt === 'algorithmic' && request.videoId) {
                        finalMetadata = {
                            ...finalMetadata,
                            coverArt: `https://i.ytimg.com/vi/${request.videoId}/hqdefault.jpg`
                        };
                    }
                }

                // If LRCLIB says the track title is different but close, prefer its wording
                if (lrclibTrack) {
                    const metaTitleNorm = basicFinalize(finalMetadata.trackName || '');
                    const lrclibNorm = basicFinalize(lrclibTrack || '');
                    if (diceCoefficient(metaTitleNorm, lrclibNorm) >= 0.6) {
                        finalMetadata.trackName = lrclibTrack;
                    }
                } else if (parsed.song) {
                    const metaTitleNorm = basicFinalize(finalMetadata.trackName || '');
                    const parsedNorm = basicFinalize(parsed.song || '');
                    if (diceCoefficient(metaTitleNorm, parsedNorm) < 0.5) {
                        finalMetadata.trackName = parsed.song;
                    }
                }

                if (!finalMetadata.coverArt && request.videoId) {
                    finalMetadata = {
                        ...finalMetadata,
                        coverArt: `https://i.ytimg.com/vi/${request.videoId}/hqdefault.jpg`
                    };
                }
                sendResponse({
                    success: !!lyricsData.lyrics, isManual: isManual,
                    metadata: finalMetadata,
                    lyrics: lyricsData.lyrics, source: lyricsData.source, error: lyricsData.error
                });
            } catch (e) { sendResponse({ success: false, error: "System error while fetching. Please try again.", metadata: null }); }
        })();
        return true;
    }
});
document.addEventListener('DOMContentLoaded', () => {
    const ui = {
        title: document.getElementById('track-title'),
        artist: document.getElementById('artist-name'),
        cover: document.getElementById('cover-art'),
        bgLayer: document.getElementById('bg-layer'),
        artContainer: document.getElementById('art-container'),
        lyricsContainer: document.getElementById('lyrics-display'),
        scrollWrapper: document.getElementById('lyrics-scroll-container'),
        shimmer: document.getElementById('art-shimmer'),
        popoutBtn: document.getElementById('popout-btn'),
        settingsBtn: document.getElementById('settings-btn'),
        searchBtn: document.getElementById('search-btn'),
        searchBar: document.getElementById('search-bar'),
        searchInput: document.getElementById('manual-input'),
        closeSearch: document.getElementById('close-search-btn'),
        playerHeader: document.getElementById('player-header'),
        sourceBadge: document.getElementById('source-badge'),
        sourceText: document.getElementById('source-text'),
        inlineSupport: document.getElementById('inline-support'),
        inlineDownload: document.getElementById('inline-download'),
        downloadBtn: document.getElementById('download-lyrics-btn')
    };

    const headerBar = document.querySelector('.header');
    let allowSupport = true;
    let allowDownload = true;
    let allowDynamicBg = true;

    chrome.storage.local.get(['settings'], (res) => {
        const settings = res.settings || { 
            theme: 'system', 
            fontFamily: 'geist', 
            textSize: 'normal', 
            popupSize: 'standard', 
            dynamicBg: true,
            stickyHeader: true,
            showSupport: true,
            showDownload: false,
            customTheme: {
                bg: '#000000',
                card: '#141414',
                text: '#ffffff',
                accent: '#5e98c8'
            }
        };

        let activeTheme = settings.theme;
        if (activeTheme === 'system') {
            activeTheme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
        }
        document.body.setAttribute('data-theme', activeTheme);
        document.body.setAttribute('data-font', settings.fontFamily);
        document.body.setAttribute('data-text-size', settings.textSize);
        document.body.setAttribute('data-popup-size', settings.popupSize);
        document.body.setAttribute('data-dynamic-bg', settings.dynamicBg);
        allowDynamicBg = settings.dynamicBg !== false;

        if (settings.theme === 'custom' && settings.customTheme) {
            const t = settings.customTheme;
            document.documentElement.style.setProperty('--bg-base', t.bg || '#000000');
            document.documentElement.style.setProperty('--card-bg', t.card || 'rgba(255,255,255,0.08)');
            document.documentElement.style.setProperty('--text-primary', t.text || '#ffffff');
            document.documentElement.style.setProperty('--accent', t.accent || '#5e98c8');
            document.documentElement.style.setProperty('--accent-dark', t.accent || '#1d569f');
        }

        // Sticky header toggle: when disabled, let the header scroll with lyrics
        const stickyOn = settings.stickyHeader !== false;
        document.body.setAttribute('data-sticky-header', stickyOn ? 'true' : 'false');
        if (!stickyOn && headerBar) {
            const scroll = document.getElementById('lyrics-scroll-container');
            if (scroll && headerBar.parentElement !== scroll) {
                scroll.insertBefore(headerBar, scroll.firstChild);
            }
        }

        // Support button visibility toggle (lyrics screen only)
        allowSupport = settings.showSupport !== false;
        if (!allowSupport && ui.inlineSupport) {
            ui.inlineSupport.style.display = 'none';
        }

        // Download lyrics button visibility toggle
        allowDownload = settings.showDownload !== false;
        if (!allowDownload && ui.inlineDownload) {
            ui.inlineDownload.style.display = 'none';
        }
    });

    const LOADER_HTML = `<div class="pulse-state"><div class="pulse-dot"></div><div class="pulse-dot"></div><div class="pulse-dot"></div></div>`;

    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('popout') === 'true') {
        ui.popoutBtn.style.display = 'none';
        document.body.classList.add('is-popout');
    }
    
    ui.popoutBtn.addEventListener('click', () => {
        chrome.windows.create({ url: chrome.runtime.getURL("popup.html?popout=true"), type: "popup", width: 450, height: 750 });
        window.close();
    });

    ui.settingsBtn.addEventListener('click', () => { chrome.runtime.openOptionsPage ? chrome.runtime.openOptionsPage() : window.open(chrome.runtime.getURL('options.html')); });
    ui.searchBtn.addEventListener('click', () => { ui.searchBar.classList.add('active'); ui.playerHeader.style.transform = 'translateY(5px)'; ui.searchInput.focus(); });
    ui.closeSearch.addEventListener('click', () => { ui.searchBar.classList.remove('active'); ui.playerHeader.style.transform = 'translateY(0)'; ui.searchInput.value = ''; });
    ui.searchInput.addEventListener('keypress', (e) => { if (e.key === 'Enter' && ui.searchInput.value.trim() !== '') { ui.closeSearch.click(); requestData(null, ui.searchInput.value.trim()); } });

    function setLyricsWithAnimation(htmlContent, showSupport) {
        ui.lyricsContainer.style.opacity = '0'; ui.lyricsContainer.style.transform = 'translateY(10px)';
        if (ui.inlineSupport) ui.inlineSupport.style.display = 'none'; // Hide support while animating
        if (ui.inlineDownload) ui.inlineDownload.style.display = 'none'; // Hide download while animating
        
        setTimeout(() => {
            ui.lyricsContainer.innerHTML = htmlContent; ui.scrollWrapper.scrollTop = 0;
            void ui.lyricsContainer.offsetWidth;
            ui.lyricsContainer.style.opacity = '1'; ui.lyricsContainer.style.transform = 'translateY(0)';
            const shouldShowSupport = showSupport && allowSupport;
            if (shouldShowSupport && ui.inlineSupport) setTimeout(() => ui.inlineSupport.style.display = 'flex', 200);

            const hasLyrics = !!htmlContent && !htmlContent.includes('error-state');
            const shouldShowDownload = hasLyrics && allowDownload;
            if (shouldShowDownload && ui.inlineDownload) {
                setTimeout(() => ui.inlineDownload.style.display = 'flex', 220);
            }
        }, 300);
    }

    function downloadCurrentLyrics() {
        if (!ui.lyricsContainer) return;
        const rawText = ui.lyricsContainer.innerText || ui.lyricsContainer.textContent || '';
        const text = rawText.trim();
        if (!text) return;

        const track = (ui.title && ui.title.textContent) ? ui.title.textContent.trim() : 'Lyrics';
        const artist = (ui.artist && ui.artist.textContent) ? ui.artist.textContent.trim() : '';
        const baseName = artist ? `${artist} - ${track}` : track;
        const safeName = baseName.replace(/[\\\/:*?"<>|]+/g, '').slice(0, 80) || 'lyrics';

        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${safeName}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    if (ui.downloadBtn) {
        ui.downloadBtn.addEventListener('click', downloadCurrentLyrics);
    }

    function generateGradient(str) {
        let hash = 0; for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
        const hue = Math.abs(hash) % 360;
        return `linear-gradient(135deg, hsl(${hue}, 60%, 45%), hsl(${(hue + 40) % 360}, 70%, 25%))`;
    }

    function triggerFallback(track, artist) {
        ui.shimmer.style.display = 'none'; 
        ui.cover.style.opacity = '0'; 
        setTimeout(() => ui.cover.style.display = 'none', 500);
        ui.artContainer.style.background = generateGradient(track + artist);
        ui.bgLayer.style.backgroundImage = 'none';
        document.body.classList.remove('is-bright-bg');
    }

    // Disable luminance-based text inversion: always use the theme's default colors
    function applyDynamicTheme(imgUrl) {
        // We still respect the "Dynamic Background" toggle for art visibility,
        // but no longer flip text colors based on image brightness.
        // Background image is handled separately when setting ui.bgLayer.style.backgroundImage.
        return;
    }

    function updateUI(data) {
        ui.title.textContent = data.metadata.trackName; ui.artist.textContent = data.metadata.artistName;
        
        if (data.source) {
            ui.sourceText.textContent = data.source;
            ui.sourceBadge.classList.add('show');
        } else {
            ui.sourceBadge.classList.remove('show');
        }

        if (data.metadata.coverArt && data.metadata.coverArt !== 'algorithmic') {
            ui.cover.onerror = () => triggerFallback(data.metadata.trackName, data.metadata.artistName);
            ui.cover.src = data.metadata.coverArt;
            ui.cover.onload = () => { ui.shimmer.style.display = 'none'; ui.cover.style.display = 'block'; setTimeout(() => ui.cover.style.opacity = '1', 50); };
            ui.bgLayer.style.backgroundImage = `url(${data.metadata.coverArt})`; ui.artContainer.style.background = 'transparent';
            applyDynamicTheme(data.metadata.coverArt);
        } else {
            triggerFallback(data.metadata.trackName, data.metadata.artistName);
        }

        if (data.success && data.lyrics) {
            setLyricsWithAnimation(`<div class="lyric-animate-in">${data.lyrics}</div>`, true);
        } else {
            const fallbackError = "Please don’t hate us sadface <br>Lyrics could not be found for this track.";
            const errorMessage = data.error || fallbackError;
            const isSadfaceError = errorMessage.includes("Please don’t hate us");
            setLyricsWithAnimation(
                `<div class="error-state"><span class="error-text">${errorMessage}</span><span class="error-subtext"></span><button class="primary-btn" id="trigger-search-btn">Search Manually</button></div>`,
                !isSadfaceError
            );
            setTimeout(() => { const btn = document.getElementById('trigger-search-btn'); if (btn) btn.addEventListener('click', () => ui.searchBtn.click()); }, 350);
        }
    }

    function triggerNotPlaying() {
        ui.title.textContent = "Not Playing";
        ui.artist.textContent = "Refresh your YouTube tab, then try again.";
        setLyricsWithAnimation("", false); 
        ui.shimmer.style.display = 'none'; ui.bgLayer.style.backgroundImage = 'none'; ui.artContainer.style.background = 'var(--glass)';
        ui.sourceBadge.classList.remove('show'); document.body.classList.remove('is-bright-bg');
    }

    function requestData(tabId, manualQuery = null) {
        ui.title.textContent = "Connecting..."; ui.artist.textContent = "Analyzing track metadata";
        setLyricsWithAnimation(LOADER_HTML, false); ui.cover.style.opacity = '0'; ui.shimmer.style.display = 'block';
        ui.sourceBadge.classList.remove('show'); document.body.classList.remove('is-bright-bg');

        if (manualQuery) {
            chrome.runtime.sendMessage({ action: "fetchSongData", manualQuery: manualQuery }, (res) => { if (res) updateUI(res); });
        } else {
            // X100: Ultimate crash prevention. If tabId doesn't exist, halt execution gracefully.
            if (!tabId || typeof tabId !== 'number' || tabId < 0) return triggerNotPlaying();
            
            chrome.tabs.sendMessage(tabId, {action: "getVideoInfo"}, (response) => {
                if (chrome.runtime.lastError || !response || (!response.title && !response.uploader)) {
                    return triggerNotPlaying();
                }
                chrome.runtime.sendMessage({ action: "fetchSongData", title: response.title, uploader: response.uploader, videoId: response.videoId }, (res) => { if (res) updateUI(res); });
            });
        }
    }

    function init() {
        chrome.tabs.query({url: ["*://*.youtube.com/*", "*://music.youtube.com/*"]}, (tabs) => {
            const watchTabs = tabs.filter(t => t.url.includes('/watch'));
            if (!watchTabs || watchTabs.length === 0) return requestData(null);
            let targetTab = watchTabs.find(t => t.active) || watchTabs[0];
            if (targetTab && targetTab.id) requestData(targetTab.id);
            else requestData(null);
        });
    }

    chrome.runtime.onMessage.addListener((msg) => { if (msg.action === "songChanged") init(); });
    init();
});
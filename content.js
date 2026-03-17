let lastTitle = "";

function getSongDetails() {
    let title = "", uploader = "", videoId = "";
    const isYTMusic = window.location.hostname === 'music.youtube.com';

    try {
        if (isYTMusic) {
            const titleEl = document.querySelector('yt-formatted-string.title.ytmusic-player-bar');
            const uploaderEl = document.querySelector('yt-formatted-string.byline.ytmusic-player-bar a');
            if (titleEl) title = titleEl.innerText;
            if (uploaderEl) uploader = uploaderEl.innerText;
            // YT Music uses the "v" query param for video id as well
            const params = new URLSearchParams(window.location.search);
            videoId = params.get('v') || "";
        } else {
            // PRIMARY TRUTH: Document title updates instantly on YouTube SPA navigation.
            let docTitle = document.title ? document.title.replace(/\s*(?:-\s*YouTube|YouTube)$/i, '').trim() : "";
            docTitle = docTitle.replace(/^\(\d+\)\s*/, '');
            
            const uploaderEl = document.querySelector('#upload-info .yt-formatted-string') || document.querySelector('.ytd-channel-name a');
            if (uploaderEl) uploader = uploaderEl.innerText;
            
            title = docTitle;

            // FALLBACK: If title is empty or just generic, check DOM.
            if (!title) {
                const chapterEl = document.querySelector('.ytp-chapter-title-content');
                const mainTitleEl = document.querySelector('h1.ytd-watch-metadata yt-formatted-string') || document.querySelector('.title.ytd-video-primary-info-renderer');
                if (chapterEl && chapterEl.innerText) title = chapterEl.innerText;
                else if (mainTitleEl) title = mainTitleEl.innerText;
            }

            // Extract video id from URL for better cover art fallbacks
            const params = new URLSearchParams(window.location.search);
            videoId = params.get('v') || "";
        }
    } catch (e) { console.error("Fetcher Detection Error:", e); }

    if (!title) return { title: "", uploader: "", videoId: "" };
    return { title: title.trim(), uploader: uploader ? uploader.trim() : "", videoId };
}

function notifyChange() {
    if (!chrome.runtime?.id) return;
    const isYTMusic = window.location.hostname === 'music.youtube.com';
    // Allow YT Music even though it doesn't use /watch URLs
    if (!isYTMusic && !window.location.pathname.includes('/watch')) return;
    const details = getSongDetails();
    if (details.title && details.title !== lastTitle) {
        lastTitle = details.title;
        try {
            chrome.runtime.sendMessage({ action: "songChanged", data: details }).catch(() => {});
        } catch (e) {
            console.warn("Lyrics Fetcher context invalidated. Please refresh the page.");
        }
    }
}

// Observer heavily locked onto the <title> tag for instant, zero-lag playlist updates
const observer = new MutationObserver(() => notifyChange());
const titleTag = document.querySelector('title');
if (titleTag) {
    observer.observe(titleTag, { childList: true, characterData: true, subtree: true });
}

document.addEventListener('yt-navigate-finish', () => setTimeout(notifyChange, 300));
document.addEventListener('yt-page-data-updated', () => setTimeout(notifyChange, 300));
setInterval(notifyChange, 2000);

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    if (!chrome.runtime?.id) return;
    if (req.action === "getVideoInfo") sendResponse(getSongDetails());
    return true;
});
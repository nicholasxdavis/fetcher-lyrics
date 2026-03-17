document.addEventListener('DOMContentLoaded', () => {
    chrome.storage.local.get(['settings'], (res) => {
        if (res.settings && res.settings.theme === 'light') {
            document.body.setAttribute('data-theme', 'light');
        }
    });

    document.getElementById('close-welcome-btn').addEventListener('click', () => {
        window.close();
    });
});
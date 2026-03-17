document.addEventListener('DOMContentLoaded', () => {
    const state = {
        theme: 'system',
        font: 'geist',
        text: 'normal',
        popup: 'standard',
        bg: true,
        cache: true,
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

    function setupCustomDropdown(elId, stateKey) {
        const container = document.getElementById(elId);
        const selectedDiv = container.querySelector('.select-selected');
        const itemsDiv = container.querySelector('.select-items');
        const options = itemsDiv.querySelectorAll('div');

        const initOpt = Array.from(options).find(o => o.getAttribute('data-val') === state[stateKey]);
        if (initOpt) selectedDiv.innerHTML = initOpt.innerHTML;

        selectedDiv.addEventListener('click', function(e) {
            e.stopPropagation();
            closeAllSelect(this);
            this.nextSibling.nextSibling.classList.toggle('select-hide');
            this.classList.toggle('select-arrow-active');
        });

        options.forEach(opt => {
            opt.addEventListener('click', function(e) {
                selectedDiv.innerHTML = this.innerHTML;
                state[stateKey] = this.getAttribute('data-val');
                
                const sameAs = this.parentNode.querySelectorAll('.same-as-selected');
                sameAs.forEach(s => s.classList.remove('same-as-selected'));
                this.classList.add('same-as-selected');
                
                selectedDiv.click(); 
                saveSettings(); 
            });
        });
    }

    function closeAllSelect(elmnt) {
        const arrNo = [];
        const items = document.getElementsByClassName('select-items');
        const selected = document.getElementsByClassName('select-selected');
        for (let i = 0; i < selected.length; i++) {
            if (elmnt == selected[i]) arrNo.push(i);
            else selected[i].classList.remove('select-arrow-active');
        }
        for (let i = 0; i < items.length; i++) {
            if (arrNo.indexOf(i) === -1) items[i].classList.add('select-hide');
        }
    }
    document.addEventListener('click', closeAllSelect);

    const bgToggle = document.getElementById('bg-toggle');
    const cacheToggle = document.getElementById('cache-toggle');
    const stickyHeaderToggle = document.getElementById('sticky-header-toggle');
    const supportToggle = document.getElementById('support-toggle');
    const downloadToggle = document.getElementById('download-toggle');
    const customThemeRow = document.getElementById('custom-theme-row');
    const customBgHost = document.getElementById('custom-bg');
    const customCardHost = document.getElementById('custom-card');
    const customTextHost = document.getElementById('custom-text');
    const customAccentHost = document.getElementById('custom-accent');
    const statusEl = document.getElementById('save-status');

    let pickrBg, pickrCard, pickrText, pickrAccent;

    function applyThemeToOptions() {
        let active = state.theme === 'system'
            ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
            : state.theme;
        document.body.setAttribute('data-theme', active);

        let fontStack = "'Geist', sans-serif";
        if (state.font === 'inter') {
            fontStack = "'Inter', sans-serif";
        } else if (state.font === 'system') {
            fontStack = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
        } else if (state.font === 'dm-sans') {
            fontStack = "'DM Sans', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
        } else if (state.font === 'space-grotesk') {
            fontStack = "'Space Grotesk', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
        } else if (state.font === 'serif') {
            fontStack = "'DM Serif Text', 'Times New Roman', serif";
        }

        document.documentElement.style.setProperty('--font-family', fontStack);

        if (customThemeRow) {
            customThemeRow.style.display = state.theme === 'custom' ? 'flex' : 'none';
        }

        // Live-apply custom theme colors to the Control Center UI
        if (state.theme === 'custom' && state.customTheme) {
            const t = state.customTheme;
            document.documentElement.style.setProperty('--bg-color', t.bg || '#000000');
            document.documentElement.style.setProperty('--card-bg', t.card || '#141414');
            document.documentElement.style.setProperty('--text-primary', t.text || '#ffffff');
            document.documentElement.style.setProperty('--accent', t.accent || '#5e98c8');
            // Use accent as a safe fallback for the darker accent shade (buttons hover, etc.)
            document.documentElement.style.setProperty('--accent-dark', t.accent || '#1d569f');
        } else {
            // Reset overrides so preset themes (light, midnight, etc.) take over again
            document.documentElement.style.removeProperty('--bg-color');
            document.documentElement.style.removeProperty('--card-bg');
            document.documentElement.style.removeProperty('--text-primary');
            document.documentElement.style.removeProperty('--accent');
            document.documentElement.style.removeProperty('--accent-dark');
        }
    }

    function saveSettings() {
        const newSettings = {
            theme: state.theme,
            fontFamily: state.font,
            textSize: state.text,
            popupSize: state.popup,
            dynamicBg: bgToggle.checked,
            useCache: cacheToggle.checked,
            stickyHeader: stickyHeaderToggle.checked,
            showSupport: supportToggle.checked,
            showDownload: downloadToggle.checked,
            customTheme: state.customTheme
        };
        chrome.storage.local.set({ settings: newSettings }, () => {
            applyThemeToOptions();
            statusEl.classList.add('show');
            setTimeout(() => statusEl.classList.remove('show'), 2000);
        });
    }

    chrome.storage.local.get(['settings'], (res) => {
        const s = res.settings || { 
            theme: 'system', 
            fontFamily: 'geist', 
            textSize: 'normal', 
            popupSize: 'standard', 
            dynamicBg: true, 
            useCache: true,
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
        
        state.theme = s.theme; 
        state.font = s.fontFamily; 
        state.text = s.textSize; 
        state.popup = s.popupSize;
        state.stickyHeader = s.stickyHeader !== false;
        state.showSupport = s.showSupport !== false;
        state.showDownload = s.showDownload !== false;
        if (s.customTheme) {
            state.customTheme = {
                bg: s.customTheme.bg || state.customTheme.bg,
                card: s.customTheme.card || state.customTheme.card,
                text: s.customTheme.text || state.customTheme.text,
                accent: s.customTheme.accent || state.customTheme.accent
            };
        }

        bgToggle.checked = s.dynamicBg;
        cacheToggle.checked = s.useCache;
        stickyHeaderToggle.checked = state.stickyHeader;
        supportToggle.checked = state.showSupport;
        downloadToggle.checked = state.showDownload;

        if (window.Pickr && customBgHost && customCardHost && customTextHost && customAccentHost) {
            const makePickr = (el, color, onChange) => window.Pickr.create({
                el,
                theme: 'nano',
                default: color,
                components: {
                    preview: true,
                    opacity: false,
                    hue: true,
                    interaction: {
                        hex: true,
                        input: true,
                        save: false
                    }
                }
            }).on('change', (c) => {
                const hex = c.toHEXA().toString();
                onChange(hex);
            }).on('swatchselect', (c) => {
                const hex = c.toHEXA().toString();
                onChange(hex);
            });

            pickrBg = makePickr(customBgHost, state.customTheme.bg, (val) => { state.customTheme.bg = val; saveSettings(); });
            pickrCard = makePickr(customCardHost, state.customTheme.card, (val) => { state.customTheme.card = val; saveSettings(); });
            pickrText = makePickr(customTextHost, state.customTheme.text, (val) => { state.customTheme.text = val; saveSettings(); });
            pickrAccent = makePickr(customAccentHost, state.customTheme.accent, (val) => { state.customTheme.accent = val; saveSettings(); });
        }

        setupCustomDropdown('dropdown-theme', 'theme');
        setupCustomDropdown('dropdown-font', 'font');
        setupCustomDropdown('dropdown-text', 'text');
        setupCustomDropdown('dropdown-popup', 'popup');

        applyThemeToOptions();
    });

    bgToggle.addEventListener('change', saveSettings);
    cacheToggle.addEventListener('change', saveSettings);
    stickyHeaderToggle.addEventListener('change', saveSettings);
    supportToggle.addEventListener('change', saveSettings);
    downloadToggle.addEventListener('change', saveSettings);
});
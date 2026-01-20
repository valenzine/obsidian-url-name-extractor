import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, requestUrl } from 'obsidian';

interface SitePattern {
    urlMatch: string;
    titleRegex: string;
}

interface UrlNameExtractorSettings {
    urlRegex: string;
    sitePatterns: SitePattern[];
    useArchiveFallback: boolean;
    useMicrolinkFallback: boolean;
    microlinkApiKey: string;
    fallbackPriority: 'archive-first' | 'microlink-first';
    followRedirects: boolean;
    maxRedirects: number;
}

const DEFAULT_SETTINGS: UrlNameExtractorSettings = {
    urlRegex: 'https?:\\/\\/[^\\s\\]\\)]+',
    sitePatterns: [],
    useArchiveFallback: false,
    useMicrolinkFallback: false,
    microlinkApiKey: '',
    fallbackPriority: 'microlink-first',
    followRedirects: true,
    maxRedirects: 5
};

export default class UrlNamer extends Plugin {

    modal: MsgModal = new MsgModal(this.app);
    settings: UrlNameExtractorSettings;

    async onload() {
        await this.loadSettings();

        this.addCommand({
            id: 'convert-urls-to-titled-links',
            name: 'Name the URL links in the selected text',
            editorCallback: (editor: Editor, view: MarkdownView) => {
                const loadingIndicator = new Notice('Fetching titles for selected text...', 0);
                UrlTagger.getTaggedText(editor.getSelection(), this.settings)
                    .then(taggedText => {
                        editor.replaceSelection(taggedText);
                        loadingIndicator.hide();
                    })
                    .catch(e => this.modal.showMsg(e.message));
            }
        });

        this.addSettingTab(new UrlNameExtractorSettingTab(this.app, this));
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

}

class UrlNameExtractorSettingTab extends PluginSettingTab {
    plugin: UrlNamer;

    constructor(app: App, plugin: UrlNamer) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;

        containerEl.empty();

        new Setting(containerEl)
            .setName('URL regex pattern')
            .setDesc('Regular expression to detect URLs in text. Uses JavaScript regex syntax with global and case-insensitive flags.')
            .addTextArea(text => text
                .setPlaceholder('Enter regex pattern')
                .setValue(this.plugin.settings.urlRegex)
                .onChange(async (value) => {
                    // Validate regex
                    try {
                        new RegExp(value, 'gim');
                        this.plugin.settings.urlRegex = value;
                        await this.plugin.saveSettings();
                    } catch (e) {
                        new Notice(`Invalid regex pattern: ${e.message}`, 5000);
                    }
                })
                .then(component => {
                    component.inputEl.rows = 3;
                    component.inputEl.cols = 50;
                }));

        new Setting(containerEl)
            .setName('Site-specific title patterns')
            .setDesc('For websites with non-standard title tags. Format: one pattern per line as "urlMatch|titleRegex". Example: "arxiv.org|<meta name=\\"citation_title\\" content=\\"([^\\"]*)\\">"')
            .addTextArea(text => text
                .setPlaceholder('arxiv.org|<meta name="citation_title" content="([^"]*)">')
                .setValue(this.plugin.settings.sitePatterns
                    .map(p => `${p.urlMatch}|${p.titleRegex}`)
                    .join('\n'))
                .onChange(async (value) => {
                    try {
                        const patterns: SitePattern[] = [];
                        const lines = value.split('\n').filter(line => line.trim());
                        
                        for (const line of lines) {
                            const parts = line.split('|');
                            if (parts.length < 2) {
                                throw new Error(`Invalid format in line: "${line}". Expected format: urlMatch|titleRegex`);
                            }
                            
                            const urlMatch = parts[0].trim();
                            const titleRegex = parts.slice(1).join('|').trim(); // Handle | in regex
                            
                            // Validate regex
                            new RegExp(titleRegex, 'im');
                            
                            patterns.push({ urlMatch, titleRegex });
                        }
                        
                        this.plugin.settings.sitePatterns = patterns;
                        await this.plugin.saveSettings();
                    } catch (e) {
                        new Notice(`Invalid site pattern: ${e.message}`, 5000);
                    }
                })
                .then(component => {
                    component.inputEl.rows = 8;
                    component.inputEl.cols = 50;
                }));

        new Setting(containerEl)
            .setName('Use Archive.org fallback')
            .setDesc('When a site blocks access (e.g., Cloudflare), attempt to fetch from Archive.org\'s Wayback Machine. May not have recent content.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.useArchiveFallback)
                .onChange(async (value) => {
                    this.plugin.settings.useArchiveFallback = value;
                    await this.plugin.saveSettings();
                    this.display(); // Refresh to show/hide priority setting
                }));

        new Setting(containerEl)
            .setName('Use Microlink fallback')
            .setDesc('When a site blocks access, fetch title via Microlink API. URLs are sent to a third-party service. ⚠️ Free tier: 50 requests/day — when exhausted, other fallbacks will be tried.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.useMicrolinkFallback)
                .onChange(async (value) => {
                    this.plugin.settings.useMicrolinkFallback = value;
                    await this.plugin.saveSettings();
                    this.display(); // Refresh to show/hide API key and priority settings
                }));

        if (this.plugin.settings.useMicrolinkFallback) {
            new Setting(containerEl)
                .setName('Microlink API key (optional)')
                .setDesc('Enter your Microlink API key for higher rate limits. Leave empty to use the free tier (50 requests/day).')
                .addText(text => text
                    .setPlaceholder('Enter API key')
                    .setValue(this.plugin.settings.microlinkApiKey)
                    .onChange(async (value) => {
                        this.plugin.settings.microlinkApiKey = value.trim();
                        await this.plugin.saveSettings();
                    })
                    .then(component => {
                        component.inputEl.type = 'password';
                        component.inputEl.style.width = '300px';
                    }));
        }

        // Show priority setting only when both fallbacks are enabled
        if (this.plugin.settings.useArchiveFallback && this.plugin.settings.useMicrolinkFallback) {
            new Setting(containerEl)
                .setName('Fallback priority order')
                .setDesc('When both fallbacks are enabled, which should be tried first?')
                .addDropdown(dropdown => dropdown
                    .addOption('microlink-first', 'Microlink → Archive.org (recommended: more reliable)')
                    .addOption('archive-first', 'Archive.org → Microlink (privacy-focused: non-profit first)')
                    .setValue(this.plugin.settings.fallbackPriority)
                    .onChange(async (value: 'archive-first' | 'microlink-first') => {
                        this.plugin.settings.fallbackPriority = value;
                        await this.plugin.saveSettings();
                    }));
        }

        new Setting(containerEl)
            .setName('Follow HTTP redirects')
            .setDesc('Automatically follow redirects (301, 302, etc.) when fetching page titles. Disable if you only want to fetch from the exact URL provided.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.followRedirects)
                .onChange(async (value) => {
                    this.plugin.settings.followRedirects = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Maximum redirects')
            .setDesc('Maximum number of redirects to follow before giving up. Prevents infinite redirect loops.')
            .addSlider(slider => slider
                .setLimits(1, 10, 1)
                .setValue(this.plugin.settings.maxRedirects)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.maxRedirects = value;
                    await this.plugin.saveSettings();
                }));
    }
}

class MsgModal extends Modal {

    constructor(app: App) {
        super(app);
    }

    msg: string;

    showMsg(theMsg: string) {
        this.msg = theMsg;
        this.open();
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.setText(this.msg);
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }

}

class UrlTagger {

    static async getTaggedText(selectedText: string, settings: UrlNameExtractorSettings) {
        const promises: any[] = [];
        const urlsToProcess: string[] = [];
        
        let urlPattern: RegExp;
        try {
            urlPattern = new RegExp(settings.urlRegex, 'gim');
        } catch (e) {
            new Notice(`Invalid URL regex pattern in settings: ${e.message}`, 5000);
            return selectedText;
        }

        // Find all URLs and check if they're already in markdown links
        let match;
        while ((match = urlPattern.exec(selectedText)) !== null) {
            const url = match[0];
            const matchIndex = match.index;
            
            // Check if URL is already part of a markdown link [text](url)
            // Look for "](" before the URL
            const beforeUrl = selectedText.substring(Math.max(0, matchIndex - 2), matchIndex);
            const isInMarkdownLink = beforeUrl === '](';
            
            if (!isInMarkdownLink) {
                urlsToProcess.push(url);
                const promise = UrlTitleFetcher.getNamedUrlTag(url, settings);
                promises.push(promise);
            }
        }

        if (urlsToProcess.length === 0) {
            new Notice('No raw URLs found to process.');
            return selectedText;
        }

        const namedTags = await Promise.all(promises);

        new Notice(`Processed ${namedTags.length} urls.`);

        // Replace URLs with their named versions
        let result = selectedText;
        urlsToProcess.forEach((url, index) => {
            result = result.replace(url, namedTags[index]);
        });

        return result;
    }

}

class UrlTitleFetcher {

    static htmlTitlePattern = /<title[^>]*>([^<]*)<\/title>/im;
    // Multiple OG title patterns to handle attribute order variations
    static ogTitlePatterns = [
        /<meta\s+property=["']og:title["']\s+content=["']([^"']*)["']/im,
        /<meta\s+content=["']([^"']*)["']\s+property=["']og:title["']/im,
        /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/im,
        /<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:title["']/im
    ];
    // LRU-style cache with size limit
    static redirectCache: Map<string, string> = new Map();
    static readonly MAX_CACHE_SIZE = 500;

    static isValidUrl(s: string): boolean {
        try {
            new URL(s);
            return true;
        } catch (err) {
            return false;
        }
    };

    // Cache management with LRU eviction
    private static addToCache(key: string, value: string): void {
        // If cache is full, remove oldest entries (first 10%)
        if (this.redirectCache.size >= this.MAX_CACHE_SIZE) {
            const keysToDelete = Array.from(this.redirectCache.keys())
                .slice(0, Math.floor(this.MAX_CACHE_SIZE * 0.1));
            keysToDelete.forEach(k => this.redirectCache.delete(k));
        }
        this.redirectCache.set(key, value);
    }

    static parseTitle(url: string, body: string, settings: UrlNameExtractorSettings): string {
        // Check site-specific patterns first
        for (const pattern of settings.sitePatterns) {
            if (url.includes(pattern.urlMatch)) {
                try {
                    const regex = new RegExp(pattern.titleRegex, 'im');
                    const match = body.match(regex);
                    if (match && typeof match[1] === 'string' && match[1].trim()) {
                        return match[1].trim();
                    }
                } catch (e) {
                    new Notice(`Invalid regex for ${pattern.urlMatch}: ${e.message}`, 5000);
                }
            }
        }

        // Try standard HTML title tag
        let title = '';
        const titleMatch = body.match(this.htmlTitlePattern);
        if (titleMatch && typeof titleMatch[1] === 'string') {
            title = titleMatch[1].trim();
        }

        // If title is empty, try Open Graph title meta tags (multiple patterns for attribute order variations)
        if (!title) {
            for (const pattern of this.ogTitlePatterns) {
                const ogMatch = body.match(pattern);
                if (ogMatch && typeof ogMatch[1] === 'string' && ogMatch[1].trim()) {
                    title = ogMatch[1].trim();
                    break;
                }
            }
        }

        // Validate that we got a non-empty title
        if (!title) {
            throw new Error('Unable to parse the title tag (empty or not found)');
        }

        return title;
    }

    static async getNamedUrlTag(url: string, settings: UrlNameExtractorSettings): Promise<string> {
        const reqUrl = url.startsWith('http') ? url : `http://${url}`;

        if (!this.isValidUrl(reqUrl)) {
            new Notice(`${url} is not a valid URL.`);
            return url;
        }

        try {
            // Check redirect cache first
            const cachedRedirect = this.redirectCache.get(reqUrl);
            const targetUrl = cachedRedirect || reqUrl;
            
            const { finalUrl, body } = await this.fetchWithRedirects(
                targetUrl,
                settings,
                0,
                []
            );
            
            // Cache the redirect mapping if we followed any redirects (with LRU eviction)
            if (finalUrl !== reqUrl && !cachedRedirect) {
                this.addToCache(reqUrl, finalUrl);
            }
            
            // Detect Cloudflare or other bot protection
            const bodyLower = body.toLowerCase();
            const isBlocked = bodyLower.includes('just a moment') || 
                bodyLower.includes('checking your browser') ||
                body.includes('challenge-platform') ||
                (bodyLower.includes('cloudflare') && bodyLower.includes('ray id'));
            
            if (isBlocked) {
                // Build fallback chain based on settings and priority
                const fallbacks: Array<{name: string, fn: () => Promise<string>}> = [];
                
                if (settings.fallbackPriority === 'microlink-first') {
                    if (settings.useMicrolinkFallback) {
                        fallbacks.push({ name: 'Microlink', fn: () => this.tryMicrolinkFallback(reqUrl, settings) });
                    }
                    if (settings.useArchiveFallback) {
                        fallbacks.push({ name: 'Archive.org', fn: () => this.tryArchiveFallbackTitle(reqUrl, settings) });
                    }
                } else {
                    if (settings.useArchiveFallback) {
                        fallbacks.push({ name: 'Archive.org', fn: () => this.tryArchiveFallbackTitle(reqUrl, settings) });
                    }
                    if (settings.useMicrolinkFallback) {
                        fallbacks.push({ name: 'Microlink', fn: () => this.tryMicrolinkFallback(reqUrl, settings) });
                    }
                }
                
                // Try fallbacks in order
                let lastError = '';
                for (const fallback of fallbacks) {
                    try {
                        const title = await fallback.fn();
                        new Notice(`📦 Title fetched via ${fallback.name}`, 3000);
                        return `[${title}](${url})`;
                    } catch (e) {
                        const errorMessage = e instanceof Error ? e.message : String(e);
                        // If Microlink rate limited, show specific notice
                        if (e instanceof Error && e.message === 'MICROLINK_RATE_LIMITED') {
                            new Notice('⚠️ Microlink daily limit reached (50/day). Trying next fallback...', 5000);
                        }
                        lastError = errorMessage;
                        // Continue to next fallback
                    }
                }
                
                // All fallbacks failed or none enabled
                if (fallbacks.length === 0) {
                    throw new Error('⛔ Bot protection detected (Cloudflare/similar). Enable a fallback method in settings.');
                }
                throw new Error(`⛔ Bot protection detected. All fallbacks failed. Last error: ${lastError}`);
            }
            
            const title = this.parseTitle(finalUrl, body, settings);
            // Use original URL in the markdown link, not the redirected URL
            return `[${title}](${url})`;
        } catch (error) {
            // If it's already a specific error message, use it
            const errorMsg = error.message || error.toString();
            new Notice(`Error: ${errorMsg}`, 8000);
            return url;
        }
    }

    private static async fetchWithRedirects(
        url: string,
        settings: UrlNameExtractorSettings,
        depth: number,
        redirectChain: string[]
    ): Promise<{ finalUrl: string; redirectChain: string[]; body: string }> {
        // Prevent infinite loops
        if (depth >= settings.maxRedirects) {
            const chain = redirectChain.join(' → ');
            throw new Error(`Too many redirects (${depth}). Chain: ${chain} → ${url}`);
        }

        // Detect circular redirects
        if (redirectChain.includes(url)) {
            const chain = redirectChain.join(' → ');
            throw new Error(`Circular redirect detected. Chain: ${chain} → ${url}`);
        }

        const res = await requestUrl({ 
            url: url,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Referer': 'https://www.google.com/',
                'DNT': '1',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1'
            }
        });

        // Handle redirects (3xx status codes)
        if (res.status >= 300 && res.status < 400) {
            if (!settings.followRedirects) {
                const location = res.headers['location'] || res.headers['Location'] || 'unknown';
                throw new Error(`Redirect detected (${res.status}) to: ${location}. Enable redirect following in settings.`);
            }

            const location = res.headers['location'] || res.headers['Location'];
            if (!location) {
                const chain = redirectChain.length > 0 ? ` Chain: ${redirectChain.join(' → ')} → ${url}` : '';
                throw new Error(`Redirect (${res.status}) without Location header.${chain}`);
            }

            // Resolve relative URLs
            let redirectUrl: string;
            try {
                redirectUrl = location.startsWith('http') 
                    ? location 
                    : new URL(location, url).toString();
            } catch (e) {
                throw new Error(`Invalid redirect URL: ${location}`);
            }

            // Block HTTPS → HTTP protocol downgrade for security
            if (url.startsWith('https://') && redirectUrl.startsWith('http://')) {
                const chain = redirectChain.length > 0 ? ` Chain: ${redirectChain.join(' → ')} → ${url}` : '';
                throw new Error(`Insecure redirect from HTTPS to HTTP blocked.${chain}`);
            }

            // Follow the redirect
            return await this.fetchWithRedirects(
                redirectUrl,
                settings,
                depth + 1,
                [...redirectChain, url]
            );
        }

        // Handle non-2xx responses
        if (res.status < 200 || res.status >= 300) {
            const chain = redirectChain.length > 0 ? ` Chain: ${redirectChain.join(' → ')} → ${url}` : '';
            throw new Error(`HTTP ${res.status}${chain}`);
        }

        // Success - return the final URL, redirect chain, and body
        return {
            finalUrl: url,
            redirectChain: redirectChain,
            body: res.text
        };
    }

    static async tryArchiveFallback(url: string, settings: UrlNameExtractorSettings): Promise<string> {
        try {
            const title = await this.tryArchiveFallbackTitle(url, settings);
            return `[${title}](${url})`;
        } catch (archiveError) {
            throw new Error(`⛔ Bot protection detected. Archive.org fallback failed: ${archiveError.message}`);
        }
    }

    static async tryArchiveFallbackTitle(url: string, settings: UrlNameExtractorSettings): Promise<string> {
        // Get the latest snapshot from Archive.org
        const archiveApiUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`;
        const apiRes = await requestUrl({ url: archiveApiUrl });
        
        if (apiRes.status !== 200) {
            throw new Error('Archive.org API unavailable');
        }
        
        let apiData: any;
        try {
            apiData = JSON.parse(apiRes.text);
        } catch (err: any) {
            throw new Error(`Invalid JSON from Archive.org API: ${err?.message || 'Unknown parse error'}`);
        }
        if (!apiData.archived_snapshots?.closest?.url) {
            throw new Error('No archived version found');
        }
        
        const archivedUrl = apiData.archived_snapshots.closest.url;
        
        // Fetch the archived page
        const archiveRes = await requestUrl({ url: archivedUrl });
        if (archiveRes.status !== 200) {
            throw new Error('Could not fetch archived page');
        }
        
        return this.parseTitle(url, archiveRes.text, settings);
    }

    static async tryMicrolinkFallback(url: string, settings: UrlNameExtractorSettings): Promise<string> {
        const apiUrl = `https://api.microlink.io?url=${encodeURIComponent(url)}`;
        
        // Build headers, using x-api-key for authentication (more secure than URL parameter)
        const headers: Record<string, string> = {};
        if (settings.microlinkApiKey) {
            headers['x-api-key'] = settings.microlinkApiKey;
        }
        
        const res = await requestUrl({ 
            url: apiUrl,
            headers: Object.keys(headers).length > 0 ? headers : undefined
        });
        
        // Check for rate limit (HTTP 429)
        if (res.status === 429) {
            throw new Error('MICROLINK_RATE_LIMITED');
        }
        
        let data: any;
        try {
            data = JSON.parse(res.text);
        } catch (error) {
            throw new Error('Microlink: Invalid JSON response');
        }
        
        // Check for rate limit in response body
        if (data.status === 'fail') {
            if (data.code === 'ERATE_LIMIT_EXCEEDED') {
                throw new Error('MICROLINK_RATE_LIMITED');
            }
            throw new Error(`Microlink error: ${data.message || data.code || 'Unknown error'}`);
        }
        
        if (data.status === 'success' && data.data?.title) {
            return data.data.title;
        }
        
        throw new Error('Microlink: No title found in response');
    }

}

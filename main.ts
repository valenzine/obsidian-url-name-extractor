import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, requestUrl } from 'obsidian';

// Custom error classes for special error handling
class MicrolinkRateLimitError extends Error {
    constructor() {
        super('Microlink daily limit exceeded');
        this.name = 'MicrolinkRateLimitError';
    }
}

class BotProtectionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'BotProtectionError';
    }
}

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
    requestDelay: number;
}

const DEFAULT_SETTINGS: UrlNameExtractorSettings = {
    urlRegex: 'https?:\\/\\/[^\\s\\]\\)]+',
    sitePatterns: [],
    useArchiveFallback: false,
    useMicrolinkFallback: false,
    microlinkApiKey: '',
    fallbackPriority: 'microlink-first',
    requestDelay: 1000  // 1 second delay between bulk requests to avoid rate limiting
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
        
        // Validate and clamp numeric values
        this.settings.requestDelay = Math.max(0, Math.min(5000, this.settings.requestDelay ?? 1000));
        
        // Validate fallback priority
        if (!['archive-first', 'microlink-first'].includes(this.settings.fallbackPriority)) {
            this.settings.fallbackPriority = 'microlink-first';
        }
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

        // Note: Obsidian's requestUrl() automatically handles HTTP redirects
        // No manual redirect configuration needed

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
            .setName('Delay between bulk requests')
            .setDesc('Milliseconds to wait between requests when processing multiple URLs. Helps avoid rate limiting. (Default: 1000ms = 1 second)')
            .addSlider(slider => slider
                .setLimits(0, 5000, 100)
                .setValue(this.plugin.settings.requestDelay)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.requestDelay = value;
                    await this.plugin.saveSettings();
                }));

        // Note: Obsidian's requestUrl() automatically handles HTTP redirects
        // No manual redirect configuration needed

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
            }
        }

        if (urlsToProcess.length === 0) {
            new Notice('No raw URLs found to process.');
            return selectedText;
        }

        // Process URLs sequentially with delay to avoid rate limiting
        const namedTags: string[] = [];
        let successCount = 0;
        let failureCount = 0;
        
        for (let i = 0; i < urlsToProcess.length; i++) {
            const url = urlsToProcess[i];
            
            // Add delay between requests (except for first one)
            if (i > 0) {
                await new Promise(resolve => setTimeout(resolve, settings.requestDelay || 1000));
            }
            
            try {
                const namedTag = await UrlTitleFetcher.getNamedUrlTag(url, settings);
                namedTags.push(namedTag);
                successCount++;
            } catch (error) {
                // On error, keep the original URL
                const errorMsg = error instanceof Error ? error.message : String(error);
                new Notice(`Failed to fetch title for ${url}: ${errorMsg}`, 5000);
                namedTags.push(url);
                failureCount++;
            }
        }

        new Notice(`Processed ${namedTags.length} URLs: ${successCount} successful, ${failureCount} failed.`);

        // Replace URLs with their named versions
        // Important: Can't use simple replace() because it only replaces first occurrence
        // and URLs might share prefixes (e.g., example.com/ and example.com/page)
        // Instead, track original match positions and replace in reverse order
        let result = selectedText;
        
        // Build array of replacements with their original positions
        const replacements: Array<{start: number, end: number, replacement: string}> = [];
        let replaceMatch;
        const replacePattern = new RegExp(settings.urlRegex, 'gim');
        let processedIndex = 0;
        
        while ((replaceMatch = replacePattern.exec(selectedText)) !== null) {
            const url = replaceMatch[0];
            const matchIndex = replaceMatch.index;
            
            // Check if URL is already in markdown link
            const beforeUrl = selectedText.substring(Math.max(0, matchIndex - 2), matchIndex);
            const isInMarkdownLink = beforeUrl === '](';
            
            if (!isInMarkdownLink && processedIndex < namedTags.length) {
                replacements.push({
                    start: matchIndex,
                    end: matchIndex + url.length,
                    replacement: namedTags[processedIndex]
                });
                processedIndex++;
            }
        }
        
        // Apply replacements in reverse order (end to start) to preserve positions
        replacements.reverse().forEach(({ start, end, replacement }) => {
            result = result.substring(0, start) + replacement + result.substring(end);
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

    static isValidUrl(s: string): boolean {
        try {
            new URL(s);
            return true;
        } catch (err) {
            return false;
        }
    };

    static decodeHtmlEntities(text: string): string {
        // Decode common HTML entities
        const entities: Record<string, string> = {
            '&amp;': '&',
            '&lt;': '<',
            '&gt;': '>',
            '&quot;': '"',
            '&#39;': "'",
            '&apos;': "'",
            '&nbsp;': ' ',
            '&rsquo;': '\u2019',
            '&lsquo;': '\u2018',
            '&rdquo;': '\u201d',
            '&ldquo;': '\u201c',
            '&ndash;': '–',
            '&mdash;': '—',
            '&hellip;': '…',
            '&bull;': '•'
        };
        
        let decoded = text;
        for (const [entity, char] of Object.entries(entities)) {
            decoded = decoded.replace(new RegExp(entity, 'g'), char);
        }
        
        // Decode numeric entities (&#123; and &#xAB;)
        decoded = decoded.replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(parseInt(dec, 10)));
        decoded = decoded.replace(/&#x([0-9A-Fa-f]+);/g, (match, hex) => String.fromCharCode(parseInt(hex, 16)));
        
        return decoded;
    }

    static parseTitle(url: string, body: string, settings: UrlNameExtractorSettings): string {
        // Check site-specific patterns first
        for (const pattern of settings.sitePatterns) {
            if (url.includes(pattern.urlMatch)) {
                try {
                    const regex = new RegExp(pattern.titleRegex, 'im');
                    const match = body.match(regex);
                    if (match && typeof match[1] === 'string' && match[1].trim()) {
                        return this.decodeHtmlEntities(match[1].trim());
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

        // Decode HTML entities
        return this.decodeHtmlEntities(title);
    }

    static async getNamedUrlTag(url: string, settings: UrlNameExtractorSettings): Promise<string> {
        const reqUrl = url.startsWith('http') ? url : `http://${url}`;

        if (!this.isValidUrl(reqUrl)) {
            new Notice(`${url} is not a valid URL.`);
            return url;
        }

        try {
            // STEP 1: Try simple fetch first (works for most sites including Amazon)
            let result: { body: string; status: number } | null = null;
            let fetchError: any = null;
            
            try {
                result = await this.fetchWithHeaders(reqUrl, false);
            } catch (simpleError) {
                fetchError = simpleError;
                // If simple fetch fails (network error), try with complex browser headers
                try {
                    result = await this.fetchWithHeaders(reqUrl, true);
                    fetchError = null;  // Success with complex headers
                } catch (complexError) {
                    fetchError = complexError;  // Both failed with network errors
                }
            }
            
            // If both fetch attempts failed with network errors, throw
            if (fetchError) {
                throw fetchError;
            }
            
            if (!result) {
                throw new Error('Failed to fetch URL');
            }
            
            const { body, status } = result;
            
            // STEP 2: Detect bot protection
            // Status codes 202/403/503 indicate protection even with empty body
            // Content patterns catch Cloudflare/AWS WAF when status is 200
            const bodyLower = body.toLowerCase();
            const isBotProtectedStatus = status === 202 || status === 403 || status === 503;
            const isBotProtectedContent = bodyLower.includes('just a moment') || 
                bodyLower.includes('checking your browser') ||
                body.includes('challenge-platform') ||
                body.includes('awsWafCookieDomainList') ||
                (bodyLower.includes('cloudflare') && bodyLower.includes('ray id'));
            
            const isBlocked = isBotProtectedStatus || isBotProtectedContent;
            
            if (isBlocked) {
                // Build fallback chain
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
                
                let lastError = '';
                for (const fallback of fallbacks) {
                    try {
                        const title = await fallback.fn();
                        new Notice(`📦 Title fetched via ${fallback.name}`, 3000);
                        return `[${title}](${url})`;
                    } catch (e) {
                        const errorMessage = e instanceof Error ? e.message : String(e);
                        if (e instanceof MicrolinkRateLimitError) {
                            new Notice('⚠️ Microlink daily limit reached (50/day). Trying next fallback...', 5000);
                        }
                        lastError = errorMessage;
                    }
                }
                
                if (fallbacks.length === 0) {
                    throw new Error('⛔ Bot protection detected. Enable a fallback method in settings.');
                }
                throw new Error(`⛔ Bot protection detected. All fallbacks failed. Last error: ${lastError}`);
            }
            
            // STEP 3: Parse title from successful response
            const title = this.parseTitle(reqUrl, body, settings);
            return `[${title}](${url})`;
        } catch (error) {
            const errorMsg = error.message || error.toString();
            new Notice(`Error: ${errorMsg}`, 8000);
            return url;
        }
    }

    private static async fetchWithHeaders(
        url: string,
        useComplexHeaders: boolean = false
    ): Promise<{ body: string; status: number }> {
        // Progressive complexity: Start with simple request (like url-namer)
        // Only add complex headers if needed for bot protection
        const headers = useComplexHeaders ? {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Referer': 'https://www.google.com/',
            'DNT': '1',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1'
        } : undefined;

        try {
            const res = await requestUrl({ 
                url: url,
                headers: headers
            });

            return {
                body: res.text,
                status: res.status
            };
        } catch (err: any) {
            // requestUrl throws on non-2xx status codes
            // Check if we got a 403/503/202 error response (likely bot protection)
            // Note: Obsidian's requestUrl doesn't provide response body for error statuses
            // Return status code for bot detection - content check not needed
            if (err.status === 403 || err.status === 503 || err.status === 202) {
                // Return status with empty body - bot detection will trigger on status alone
                return {
                    body: '',
                    status: err.status
                };
            }
            // Other error statuses or real network errors, re-throw
            throw err;
        }
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
        
        let archivedUrl = apiData.archived_snapshots.closest.url;
        // Fix http:// URLs from Archive.org to use https://
        if (archivedUrl.startsWith('http://')) {
            archivedUrl = archivedUrl.replace('http://', 'https://');
        }
        
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
            throw new MicrolinkRateLimitError();
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
                throw new MicrolinkRateLimitError();
            }
            // Handle EPROXYNEEDED - Microlink free tier can't bypass antibot protection
            if (data.code === 'EPROXYNEEDED') {
                throw new Error('Microlink free tier cannot bypass antibot protection (upgrade to PRO or try Archive.org)');
            }
            throw new Error(`Microlink error: ${data.message || data.code || 'Unknown error'}`);
        }
        
        if (data.status === 'success' && data.data?.title) {
            // Clean title: remove markdown links [text](url) and extract just the text
            let title = data.data.title;
            // Remove markdown links: [text](url) → text
            title = title.replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1');
            return title;
        }
        
        throw new Error('Microlink: No title found in response');
    }

}

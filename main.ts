import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, requestUrl } from 'obsidian';

interface SitePattern {
    urlMatch: string;
    titleRegex: string;
}

interface UrlNameExtractorSettings {
    urlRegex: string;
    sitePatterns: SitePattern[];
    useArchiveFallback: boolean;
}

const DEFAULT_SETTINGS: UrlNameExtractorSettings = {
    urlRegex: '(?<!\\]\\(\\s*)(?<=\\s|\\(|\\[|^)https?:\\/\\/[^\\s\\]]+',
    sitePatterns: [],
    useArchiveFallback: false
};

export default class UrlNamer extends Plugin {

    modal: MsgModal = new MsgModal(this.app);
    settings: UrlNameExtractorSettings;

    async onload() {
        await this.loadSettings();

        this.addCommand({
            id: 'url-namer-selection',
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
        
        let urlPattern: RegExp;
        try {
            urlPattern = new RegExp(settings.urlRegex, 'gim');
        } catch (e) {
            new Notice(`Invalid URL regex pattern in settings: ${e.message}`, 5000);
            return selectedText;
        }

        selectedText.replace(urlPattern, match => {
            const promise = UrlTitleFetcher.getNamedUrlTag(match, settings);
            promises.push(promise);
            return match;
        });

        const namedTags = await Promise.all(promises);

        new Notice(`Processed ${namedTags.length} urls.`);

        return selectedText.replace(urlPattern, () => namedTags.shift());
    }

}

class UrlTitleFetcher {

    static htmlTitlePattern = /<title[^>]*>([^<]*)<\/title>/im;

    static isValidUrl(s: string): boolean {
        try {
            new URL(s);
            return true;
        } catch (err) {
            return false;
        }
    };

    static parseTitle(url: string, body: string, settings: UrlNameExtractorSettings): string {
        // Check site-specific patterns first
        for (const pattern of settings.sitePatterns) {
            if (url.includes(pattern.urlMatch)) {
                try {
                    const regex = new RegExp(pattern.titleRegex, 'im');
                    const match = body.match(regex);
                    if (match && typeof match[1] === 'string') {
                        return match[1];
                    }
                } catch (e) {
                    new Notice(`Invalid regex for ${pattern.urlMatch}: ${e.message}`, 5000);
                }
            }
        }

        // Fall back to standard HTML title tag
        const match = body.match(this.htmlTitlePattern);
        if (!match || typeof match[1] !== 'string') {
            throw new Error('Unable to parse the title tag');
        }

        return match[1];
    }

    static async getNamedUrlTag(url: string, settings: UrlNameExtractorSettings): Promise<string> {
        const reqUrl = url.startsWith('http') ? url : `http://${url}`;

        if (!this.isValidUrl(reqUrl)) {
            new Notice(`${url} is not a valid URL.`);
            return url;
        }

        try {
            const res = await requestUrl({ 
                url: reqUrl,
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
            
            if (res.status != 200) {
                throw new Error(`HTTP ${res.status}`);
            }

            const body = res.text;
            
            // Detect Cloudflare or other bot protection
            const bodyLower = body.toLowerCase();
            const isBlocked = bodyLower.includes('just a moment') || 
                bodyLower.includes('checking your browser') ||
                body.includes('challenge-platform') ||
                (bodyLower.includes('cloudflare') && bodyLower.includes('ray id'));
            
            if (isBlocked) {
                // Try Archive.org fallback if enabled
                if (settings.useArchiveFallback) {
                    return await this.tryArchiveFallback(url, settings);
                }
                throw new Error('⛔ Bot protection detected (Cloudflare/similar). Enable Archive.org fallback in settings or manually copy the title.');
            }
            
            const title = this.parseTitle(url, body, settings);
            return `[${title}](${url})`;
        } catch (error) {
            // If it's already a specific error message, use it
            const errorMsg = error.message || error.toString();
            new Notice(`Error: ${errorMsg}`, 8000);
            return url;
        }
    }

    static async tryArchiveFallback(url: string, settings: UrlNameExtractorSettings): Promise<string> {
        try {
            // Get the latest snapshot from Archive.org
            const archiveApiUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`;
            const apiRes = await requestUrl({ url: archiveApiUrl });
            
            if (apiRes.status !== 200) {
                throw new Error('Archive.org API unavailable');
            }
            
            const apiData = JSON.parse(apiRes.text);
            if (!apiData.archived_snapshots?.closest?.url) {
                throw new Error('No archived version found');
            }
            
            const archivedUrl = apiData.archived_snapshots.closest.url;
            const timestamp = apiData.archived_snapshots.closest.timestamp;
            
            // Fetch the archived page
            const archiveRes = await requestUrl({ url: archivedUrl });
            if (archiveRes.status !== 200) {
                throw new Error('Could not fetch archived page');
            }
            
            const title = this.parseTitle(url, archiveRes.text, settings);
            
            const year = timestamp.substring(0, 4);
            const month = timestamp.substring(4, 6);
            const day = timestamp.substring(6, 8);
            
            new Notice(`📦 Using archived version from ${year}-${month}-${day}`, 5000);
            return `[${title}](${url})`;
        } catch (archiveError) {
            throw new Error(`⛔ Bot protection detected. Archive.org fallback failed: ${archiveError.message}`);
        }
    }

}

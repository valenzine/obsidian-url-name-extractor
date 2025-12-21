# Obsidian URL Name Extractor

**Forked from**: [obsidian-url-namer](https://github.com/zfei/obsidian-url-namer) by [zfei](https://github.com/zfei)    

This is a plugin for Obsidian (https://obsidian.md) that retrieves HTML titles to name raw URL links.

## What's New in This Fork

- **Improved URL detection**: Liberal regex pattern that correctly handles all valid URLs including:
  - Domains with any valid TLD (`.as`, `.museum`, `.technology`, etc.)
  - DOI links (`https://doi.org/10.xxxx/yyyy`)
  - Blog posts and academic articles from various platforms
- **Configurable URL regex**: Customize the URL matching pattern in plugin settings
- **Site-specific title extraction**: Define custom title regex patterns for websites with non-standard HTML (e.g., lazy-loaded content)
- **Better error handling**: Clear error messages when regex validation fails

## Usage

Select the text that contains the URLs to be named, execute the command *Name the URL links in the selected text*.

It's recommended to name few URLs at a time. In the case when the URL requests are taking some time, please **DO NOT** change the text selection or the content itself, before the command is done. Otherwise, the eventual result will be out of order.

Easier with the command binded to a keyboard shortcut.

![demo](demo/url-namer-demo.gif)

## Settings

### URL Regex Pattern

Customize the regular expression used to detect URLs in your text. The default pattern is:

```regex
(?<!\]\(\s*)(?<=\s|\(|\[|^)https?:\/\/[^\s\]]+
```

This liberal pattern matches any `http://` or `https://` URL. The plugin validates URLs using the native URL constructor, so invalid URLs are safely ignored.

### Site-Specific Title Patterns

For websites that don't use standard `<title>` tags or use lazy-loaded content, you can define custom patterns. Each pattern consists of:
- **URL Match**: A string to identify the website (e.g., `example.com`)
- **Title Regex**: A regex pattern to extract the title (e.g., `<meta property="og:title" content="([^"]*)"`)

Add one pattern per line in the format: `urlMatch|titleRegex`

**Example**:
```
arxiv.org|<meta name="citation_title" content="([^"]*)"
pubmed.ncbi.nlm.nih.gov|<meta name="citation_title" content="([^"]*)"
```

If no site-specific pattern matches, the plugin falls back to extracting from `<title>` tags.

## Known Limitations

### Cloudflare and Bot Protection

Some websites use **Cloudflare** or other bot protection systems that prevent automated access. When encountering these sites, you'll see an error message:

```
Error fetching title for [URL]: Bot protection detected (likely Cloudflare). 
This site cannot be accessed programmatically.
```

**Why this happens:**
- These protection systems require JavaScript execution and browser-like behavior
- The plugin uses simple HTTP requests which are detected as bots
- The plugin receives a challenge page instead of the actual content

**Affected sites include:**
- Sites behind Cloudflare protection (e.g., `comofuncionanlascos.as`)
- Sites behind Cloudflare's "I'm Under Attack" mode
- Sites with advanced bot detection

**Workarounds:**
1. **Enable Archive.org fallback** in settings - automatically fetches from archived snapshots
2. Manually copy the title and format as `[Title](URL)`
3. Open the URL in a browser, copy the title, then use the plugin on a placeholder

The plugin includes browser-like headers and a Google referer to minimize detection, but some sites will still block automated access.

### Archive.org Fallback

When enabled in settings, the plugin will automatically attempt to fetch titles from Archive.org's Wayback Machine if a site blocks direct access. This:
- Works for sites with Cloudflare or other bot protection
- May use slightly outdated content (shows date of archived snapshot)
- Adds a small delay while checking for archived versions
- Won't work for very recent URLs that haven't been archived yet

## Compilation

- Clone this repo.
- `npm i` or `yarn` to install dependencies
- `npm run build` to compile, or `npm run dev` to start compilation in watch mode.

## Installation

- After compiled, rename the `dist` directory to `obsidian-url-name-extractor` and move it into the vault's plugin directory `VaultFolder/.obsidian/plugins/`.

## Credits

Original plugin created by [zfei](https://github.com/zfei). This fork adds configurable regex patterns and improved URL detection.

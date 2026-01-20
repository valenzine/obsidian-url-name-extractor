# Changelog

All notable changes to this project will be documented in this file.

## 2.0.2

- Add: Microlink API fallback for Cloudflare-protected sites (Medium, custom domains)
- Add: Optional Microlink API key field for users with paid plans
- Add: Configurable fallback priority when both Archive.org and Microlink are enabled
- Add: Rate limit detection for Microlink (50/day free tier) with automatic fallback chain
- Enhancement: Fallback methods now try in sequence until one succeeds
- Note: Microlink disabled by default for privacy (URLs sent to third-party service)

## 2.0.1

- Fix: iOS compatibility by simplifying URL regex pattern (removed lookbehind assertions)
- Add: GitHub Actions workflow for automated releases

## 2.0.0

- Add: Configurable URL regex pattern in settings
- Add: Site-specific title extraction patterns for non-standard HTML
- Add: Archive.org Wayback Machine fallback for Cloudflare-protected sites
- Add: Open Graph (`og:title`) fallback when `<title>` tag is empty
- Add: Follow HTTP redirects setting with configurable max depth
- Add: Redirect loop and circular redirect detection
- Add: HTTPS → HTTP downgrade protection
- Enhancement: Browser-like headers to reduce bot detection
- Enhancement: Skip URLs already inside markdown links `[text](url)`
- Enhancement: Clear notices for processing status and errors
- Refactor: Complete rewrite of URL detection and title fetching logic
- Note: Initial fork from [obsidian-url-namer](https://github.com/zfei/obsidian-url-namer) by zfei

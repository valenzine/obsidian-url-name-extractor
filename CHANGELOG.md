# Changelog

All notable changes to this project will be documented in this file.

## 2.0.3

- Fix: Sequential processing with configurable delay prevents rate limiting when processing multiple URLs
- Fix: Bot protection detection improved - handles HTTP 202/403/503 status codes and Cloudflare/AWS WAF content patterns
- Fix: URL replacement bug that caused malformed markdown when processing overlapping URLs (e.g., example.com/ and example.com/page)
- Add: Configurable delay between bulk requests (default 1 second, adjustable 0-5 seconds in settings)
- Add: HTML entity decoding for titles - supports basic entities, typographic quotes, dashes, and numeric entities
- Add: Settings validation to ensure safe values on load
- Enhancement: Success/failure reporting shows accurate counts for processed URLs
- Removed: Custom redirect handling (~100 lines) and redirect settings UI - Obsidian's requestUrl handles this automatically
- Code Quality: Custom error classes for better error handling, removed unused cache code

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

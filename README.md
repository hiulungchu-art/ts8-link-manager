# 工作頁面集 (Workspace)

Multi-page internal tools site (GitHub Pages). Soft editorial aesthetic.

**Live:** https://hiulungchu-art.github.io/ts8-link-manager/

## Pages

| File | Description |
|------|-------------|
| `index.html` | Home / landing — cards linking to tools |
| `ts8.html` | TS8 Link Manager (Part A / B1·B2 links & PDFs, auto sync) |
| `css/site.css` | Shared nav, footer, landing styles |

## Add a new page

1. Create e.g. `other.html` (copy chrome from `index.html` or `ts8.html`)
2. Add one nav link in every page’s `.site-nav-links`:
   `<li><a href="./other.html">新頁面</a></li>`
3. Optionally add a card on the home page

## TS8 notes

- Shared data: `./data.json` (site root)
- Config: `./config.js` (Drive upload / sync web app)
- No export / manual pull buttons — auto sync only
- Isolation-day slots: B1 link, B2 link, 完整 PDF (no B1 PDF)

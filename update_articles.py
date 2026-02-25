#!/usr/bin/env python3
"""
Structural updates for all pending blog articles on thisDay.info

Changes applied:
1. Fix .text-muted CSS bug (scope to .footer only)
2. Add new CSS classes (article-meta, breadcrumb, did-you-know, analysis, etc.)
3. Fix H1 separator from " - " to ": "
4. Update header meta (class + add author + read time)
5. Add breadcrumb navigation before <article>
6. Update article inner footer (text-muted -> article-meta)
7. Remove content area bi icons (keep footer + navbar icons)
"""

import os
import re

BASE_DIR = "/Users/arminkapetanovic/devilbox/data/www/danas/htdocs/blog"
MONTHS = ["july", "august", "september", "october", "november"]

NEW_CSS = """
      /* Article-specific styles */
      .article-meta {
        color: #6c757d;
        font-size: 0.875rem;
      }

      body.dark-theme .article-meta {
        color: #94a3b8;
      }

      .breadcrumb {
        background: transparent;
        padding: 0;
        margin-bottom: 1rem;
      }

      body.dark-theme .breadcrumb-item a {
        color: #60a5fa;
      }

      body.dark-theme .breadcrumb-item.active {
        color: #94a3b8;
      }

      body.dark-theme .breadcrumb-item + .breadcrumb-item::before {
        color: #64748b;
      }

      .did-you-know {
        background: rgba(59, 130, 246, 0.08);
        border-left: 4px solid #3b82f6;
        border-radius: 0 0.5rem 0.5rem 0;
      }

      body.dark-theme .did-you-know {
        background: rgba(59, 130, 246, 0.15);
      }

      .analysis-good {
        background: rgba(34, 197, 94, 0.08);
        border: 1px solid rgba(34, 197, 94, 0.3);
      }

      body.dark-theme .analysis-good {
        background: rgba(34, 197, 94, 0.1);
        border-color: rgba(34, 197, 94, 0.25);
      }

      .analysis-bad {
        background: rgba(239, 68, 68, 0.08);
        border: 1px solid rgba(239, 68, 68, 0.3);
      }

      body.dark-theme .analysis-bad {
        background: rgba(239, 68, 68, 0.1);
        border-color: rgba(239, 68, 68, 0.25);
      }

      .related-card {
        border: 1px solid var(--card-border);
        background: var(--card-bg);
        transition: transform 0.15s ease, box-shadow 0.15s ease;
      }

      .related-card:hover {
        transform: translateY(-2px);
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
        text-decoration: none;
      }

      blockquote.historical-quote {
        border-left: 3px solid #3b82f6;
        padding-left: 1rem;
        margin-left: 0.5rem;
        font-style: italic;
      }

      body.dark-theme blockquote.historical-quote footer {
        color: #94a3b8;
      }"""


def fix_text_muted_css(content):
    """Fix the .text-muted CSS bug - scope it to .footer only"""
    # Pattern with 6-space indentation (as seen in the articles)
    old = "      .text-muted {\n        color: #fff !important;\n      }"
    new = "      /* Fix: .text-muted should only be white inside the blue footer, not the article body */\n      .footer .text-muted {\n        color: rgba(255, 255, 255, 0.85) !important;\n      }"
    if old in content:
        return content.replace(old, new, 1), True
    return content, False


def add_new_css(content):
    """Add new CSS classes before </style>"""
    if ".article-meta" in content:
        return content, False
    # Find the closing </style> tag
    style_close = "    </style>"
    if style_close in content:
        return content.replace(style_close, NEW_CSS + "\n    </style>", 1), True
    return content, False


def fix_h1_hyphen(content):
    """Fix H1 separator from ' - ' or ' – ' to ': '"""
    changed = False

    def replacer(m):
        nonlocal changed
        tag = m.group(0)
        if " - " in tag or " \u2013 " in tag:
            new_tag = tag.replace(" - ", ": ").replace(" \u2013 ", ": ")
            changed = True
            return new_tag
        return tag

    result = re.sub(r"<h1[^>]*>[^<]+</h1>", replacer, content)
    return result, changed


def fix_header_meta(content, word_count):
    """Update header meta paragraph - add article-meta class, author, read time"""
    if 'class="article-meta' in content:
        return content, False

    # Calculate read time
    read_time = max(2, word_count // 200)

    # Pattern: <p class="text-muted"><small>Published: ... | Event Date: ...</small></p>
    pattern = r'<p class="text-muted"><small>(Published:[^<]+)</small></p>'
    match = re.search(pattern, content)
    if not match:
        return content, False

    inner = match.group(1)
    # Clean up the inner text - normalize separators
    inner = inner.replace(" | ", " &nbsp;|&nbsp; ")
    # Build new header
    new_meta = (
        f'<p class="article-meta mb-0">\n'
        f"              <small>\n"
        f"                {inner} &nbsp;|&nbsp;\n"
        f"                thisDay. Editorial Team &nbsp;|&nbsp;\n"
        f"                {read_time} min read\n"
        f"              </small>\n"
        f"            </p>"
    )
    new_content = content.replace(match.group(0), new_meta, 1)
    return new_content, True


def add_breadcrumb(content):
    """Add breadcrumb navigation before <article>"""
    if "breadcrumb" in content:
        return content, False

    # Extract event name from H1
    h1_match = re.search(r"<h1[^>]*>([^<]+)</h1>", content)
    if not h1_match:
        return content, False

    event_name = h1_match.group(1).strip()
    # If H1 has a colon (after our fix), take everything before it as the event name
    if ": " in event_name:
        event_name = event_name.split(": ")[0].strip()
    # Truncate if too long
    if len(event_name) > 60:
        event_name = event_name[:57] + "..."

    breadcrumb_html = (
        f"        <!-- Breadcrumb -->\n"
        f'        <nav aria-label="breadcrumb" class="mb-3">\n'
        f'          <ol class="breadcrumb">\n'
        f'            <li class="breadcrumb-item"><a href="/">Home</a></li>\n'
        f'            <li class="breadcrumb-item"><a href="/blog/">Blog</a></li>\n'
        f'            <li class="breadcrumb-item active" aria-current="page">{event_name}</li>\n'
        f"          </ol>\n"
        f"        </nav>\n\n"
    )

    # Insert before <article
    article_pattern = r"(\s+<article\s)"
    if re.search(article_pattern, content):
        new_content = re.sub(article_pattern, "\n" + breadcrumb_html + r"\1", content, count=1)
        return new_content, True

    return content, False


def fix_article_inner_footer(content):
    """Update inner article footer class from text-muted to article-meta"""
    old = '<small class="text-muted">Part of the <strong>thisDay.</strong> historical blog archive</small>'
    new = '<small class="article-meta">Part of the <strong>thisDay.</strong> historical blog archive</small>'
    if old in content:
        return content.replace(old, new, 1), True
    return content, False


def remove_content_icons(content):
    """Remove <i class="bi bi-..."> tags from content area (not footer social icons)"""
    # Find where the site footer starts (we keep icons there)
    footer_marker = '<footer class="footer">'
    footer_pos = content.find(footer_marker)
    if footer_pos == -1:
        footer_pos = len(content)

    before_footer = content[:footer_pos]
    after_footer = content[footer_pos:]

    # Count icons before removing
    icon_pattern = r'<i class="bi bi-(?!moon-fill)[^"]*"[^>]*></i>\s*'
    icons_found = len(re.findall(icon_pattern, before_footer))

    if icons_found > 0:
        before_footer = re.sub(icon_pattern, "", before_footer)
        return before_footer + after_footer, True

    return content, False


def count_article_words(content):
    """Count words in the article body text"""
    # Remove HTML tags
    text = re.sub(r"<[^>]+>", " ", content)
    # Remove extra whitespace
    text = re.sub(r"\s+", " ", text).strip()
    words = text.split()
    return len(words)


def process_article(filepath):
    """Process a single article file. Returns (changed, changes_list)"""
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()

    # Skip if already fully updated
    if "article-meta" in content and "breadcrumb" in content:
        return False, ["already updated"]

    changes = []
    original = content

    word_count = count_article_words(content)

    content, changed = fix_text_muted_css(content)
    if changed:
        changes.append("CSS fix")

    content, changed = add_new_css(content)
    if changed:
        changes.append("new CSS classes")

    content, changed = fix_h1_hyphen(content)
    if changed:
        changes.append("H1 hyphen fix")

    content, changed = fix_header_meta(content, word_count)
    if changed:
        changes.append("header meta")

    content, changed = add_breadcrumb(content)
    if changed:
        changes.append("breadcrumb")

    content, changed = fix_article_inner_footer(content)
    if changed:
        changes.append("article footer")

    content, changed = remove_content_icons(content)
    if changed:
        changes.append("removed icons")

    if content != original:
        with open(filepath, "w", encoding="utf-8") as f:
            f.write(content)
        return True, changes

    return False, []


def main():
    updated = 0
    skipped = 0
    errors = 0

    for month in MONTHS:
        month_dir = os.path.join(BASE_DIR, month)
        if not os.path.exists(month_dir):
            continue

        day_dirs = sorted(
            os.listdir(month_dir), key=lambda d: int(d.split("-")[0])
        )
        for day_dir in day_dirs:
            filepath = os.path.join(month_dir, day_dir, "index.html")
            if not os.path.exists(filepath):
                continue
            if day_dir == "10-2025" and month == "july":
                print(f"SKIP (reference article): {filepath}")
                skipped += 1
                continue

            try:
                changed, changes = process_article(filepath)
                if changed:
                    print(f"UPDATED [{', '.join(changes)}]: {month}/{day_dir}")
                    updated += 1
                else:
                    reason = changes[0] if changes else "no matching patterns"
                    print(f"SKIP ({reason}): {month}/{day_dir}")
                    skipped += 1
            except Exception as e:
                print(f"ERROR: {month}/{day_dir}: {e}")
                errors += 1

    print(f"\n=== Done: {updated} updated, {skipped} skipped, {errors} errors ===")


if __name__ == "__main__":
    main()

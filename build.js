import { createClient } from '@libsql/client';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const db = createClient({
  url: process.env.TURSO_URL,
  authToken: process.env.TURSO_TOKEN,
});

function formatDate(dateStr) {
  if (!dateStr) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const months = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
    return `${d}. ${months[m - 1]} ${y}`;
  }
  return dateStr;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inject(html, key, content) {
  const re = new RegExp(`<!-- INJECT:${key} -->[\\s\\S]*?<!-- /INJECT:${key} -->`, 'g');
  return html.replace(re, `<!-- INJECT:${key} -->${content}<!-- /INJECT:${key} -->`);
}

// Replace the src attribute of an img that has a matching data-img-key attribute
function injectImgSrc(html, key, url) {
  return html.replace(
    new RegExp(`(<img(?=[^>]*data-img-key="${key}")[^>]*\\bsrc=")[^"]*(")`),
    `$1${url}$2`
  );
}

async function build() {
  console.log('Fetching data from DB...');

  // Ensure crop column exists
  try { await db.execute('ALTER TABLE artworks ADD COLUMN crop TEXT DEFAULT ""'); } catch(e) {}

  const [settingsRes, artworksRes, eventsRes] = await Promise.all([
    db.execute('SELECT key, value FROM settings'),
    db.execute('SELECT id, title, image_url, status, crop FROM artworks ORDER BY sort_order ASC, id ASC'),
    db.execute('SELECT id, title, date, location FROM events ORDER BY date ASC'),
  ]);

  const s = {};
  settingsRes.rows.forEach(r => { s[r.key] = r.value; });

  const artworks = artworksRes.rows;
  const events = eventsRes.rows;

  function applyContent(html) {
    // About name
    if (s.about_name) {
      html = inject(html, 'about_name', escapeHtml(s.about_name));
    }

    // About bio — split on blank lines into paragraphs
    if (s.about_bio) {
      const bioHtml = s.about_bio.split(/\n\s*\n/).filter(p => p.trim())
        .map(p => `\n          <p class="about-bio">${escapeHtml(p.trim())}</p>`).join('') + '\n          ';
      html = inject(html, 'about_bio', bioHtml);
    }

    // Instagram URL — update href attribute directly
    if (s.instagram_url) {
      html = html.replace(
        /(<a[^>]+data-inject-href="instagram_url"[^>]+href=")[^"]*(")/,
        `$1${s.instagram_url}$2`
      );
      html = html.replace(
        /(<a[^>]+href=")[^"]*("[^>]+data-inject-href="instagram_url")/,
        `$1${s.instagram_url}$2`
      );
    }

    // Footer
    if (s.footer_text) {
      html = inject(html, 'footer_text', `&copy; ${escapeHtml(s.footer_text)}`);
    }

    // Simple text fields
    const textFields = [
      'nav_about', 'nav_whatido', 'nav_gallery', 'nav_dates', 'nav_contact',
      'heading_about', 'heading_whatido', 'heading_gallery', 'heading_dates',
      'whatido_subtitle', 'gallery_note', 'instagram_text',
      'book_birthday_title', 'book_bachelorette_title', 'book_workshop_title',
      'torn_title', 'torn_desc',
      'cta_book',
      'booking_heading', 'booking_greeting', 'booking_intro',
    ];
    textFields.forEach(key => {
      if (s[key]) html = inject(html, key, escapeHtml(s[key]));
    });

    // About photo
    if (s.about_photo) {
      let aboutCropStyle = '';
      if (s.about_photo_crop) {
        try {
          const c = JSON.parse(s.about_photo_crop);
          aboutCropStyle = ` style="object-position: ${c.x||50}% ${c.y||50}%; transform-origin: ${c.x||50}% ${c.y||50}%; transform: scale(${c.scale||1});"`;
        } catch(e) {}
      }
      html = html.replace(
        /(<img(?=[^>]*id="aboutPhoto")[^>]*\bsrc=")[^"]*("[^>]*)(>)/,
        `$1${s.about_photo}$2${aboutCropStyle}$3`
      );
    }

    // About photo caption
    if ('about_photo_caption' in s) {
      const captionHtml = s.about_photo_caption
        ? `<p class="polaroid-caption">${escapeHtml(s.about_photo_caption)}</p>`
        : '';
      html = inject(html, 'about_photo_caption', captionHtml);
    }

    // Book content
    for (const name of ['birthday', 'bachelorette', 'workshop']) {
      // Checkmarks
      const checksKey = `book_${name}_checks`;
      if (s[checksKey]) {
        const items = s[checksKey].split('\n').filter(l => l.trim())
          .map(l => `\n              <li>${escapeHtml(l.trim())}</li>`).join('');
        html = inject(html, checksKey, items + '\n            ');
      }

      // Description paragraphs
      const descKey = `book_${name}_desc`;
      if (s[descKey]) {
        const descHtml = s[descKey].split(/\n\s*\n/).filter(p => p.trim())
          .map(p => `<p class="event-spread__desc">${escapeHtml(p.trim())}</p>\n            `).join('');
        html = inject(html, descKey, descHtml);
      }

      // Extra text
      const extraKey = `book_${name}_extra`;
      if (s[extraKey]) {
        html = inject(html, extraKey, escapeHtml(s[extraKey]));
      }

      // Book images: cover + details (non-photo slots)
      for (const slot of ['cover', 'details']) {
        const imgKey = `book_${name}_${slot}_img`;
        if (s[imgKey]) {
          html = injectImgSrc(html, imgKey, s[imgKey]);
          // Apply crop if set
          const cropKey = `book_${name}_${slot}_crop`;
          if (s[cropKey]) {
            try {
              const c = JSON.parse(s[cropKey]);
              const cropStyle = `object-position:${c.x||50}% ${c.y||50}%;transform-origin:${c.x||50}% ${c.y||50}%;transform:scale(${c.scale||1})`;
              html = html.replace(
                new RegExp(`(<img(?=[^>]*data-img-key="${imgKey}")[^>]*?)>`),
                `$1 style="${cropStyle}">`
              );
            } catch(e) {}
          }
        }
        const captionKey = `book_${name}_${slot}_caption`;
        if (captionKey in s) {
          const captionHtml = s[captionKey]
            ? `<p class="polaroid-caption">${escapeHtml(s[captionKey])}</p>`
            : '';
          html = inject(html, captionKey, captionHtml);
        }
      }

      // Book photos page: read JSON array or migrate from individual keys
      const photosKey = `book_${name}_photos`;
      let photos = [];
      if (s[photosKey]) {
        try { photos = JSON.parse(s[photosKey]); } catch (e) { photos = []; }
      } else {
        // Migrate from old individual photo keys
        for (let i = 1; i <= 3; i++) {
          const img = s[`book_${name}_photo${i}_img`];
          const caption = s[`book_${name}_photo${i}_caption`] || '';
          if (img) photos.push({ img, caption });
        }
      }
      if (photos.length > 0) {
        const rotations = ['-3deg', '4deg', '-1deg', '3deg', '-2deg', '2deg'];
        const attachments = ['scrapbook__tape', 'polaroid-pin', 'scrapbook__tape', 'polaroid-pin'];
        const photosHtml = photos.map((p, i) => {
          const rot = rotations[i % rotations.length];
          const attach = attachments[i % attachments.length];
          const captionHtml = p.caption ? `\n              <p class="polaroid-caption">${escapeHtml(p.caption)}</p>` : '';
          let pCropStyle = '';
          if (p.crop) {
            pCropStyle = ` style="object-position:${p.crop.x||50}% ${p.crop.y||50}%;transform-origin:${p.crop.x||50}% ${p.crop.y||50}%;transform:scale(${p.crop.scale||1});"`;
          }
          return `
            <div class="scrapbook__polaroid" style="--rot: ${rot};">
              <div class="${attach}"></div>
              <div class="polaroid-frame"><img src="${p.img}" alt="" loading="lazy"${pCropStyle}></div>${captionHtml}
            </div>`;
        }).join('');
        html = inject(html, photosKey, photosHtml + '\n          ');
      }
    }

    // Artworks gallery
    const rotations = ['-2deg', '1.5deg', '-1deg', '2.5deg', '-1.5deg', '1deg', '-0.5deg', '2deg'];
    const xPos = ['2%', '34%', '66%', '8%', '40%', '72%', '16%', '50%'];
    const yPos = ['0', '2%', '-1%', '0', '1%', '0', '2%', '-1%'];
    const attachments = ['polaroid-pin', 'tape-corner'];

    const artworksHtml = artworks.length === 0
      ? '\n      <p style="color: var(--text-light); font-family: var(--font-handwriting); text-align: center; padding: 40px;">Noch keine Werke</p>\n      '
      : '\n      ' + artworks.map((a, i) => {
        let cropStyle = '';
        if (a.crop) {
          try {
            const c = JSON.parse(a.crop);
            cropStyle = `object-position: ${c.x || 50}% ${c.y || 50}%; transform-origin: ${c.x || 50}% ${c.y || 50}%; transform: scale(${c.scale || 1});`;
          } catch(e) {}
        }
        return `<article class="polaroid p${i + 1} fade-in" style="--rot: ${rotations[i % rotations.length]}; --x: ${xPos[i % xPos.length]}; --y: ${yPos[i % yPos.length]};">
        <div class="${attachments[i % attachments.length]}"></div>
        <span class="art-sticker">${a.status === 'sold' ? 'verkauft' : 'zu verkaufen'}</span>
        <div class="polaroid-frame">
          <div class="polaroid-img-wrap"><img src="${a.image_url}" alt="${escapeHtml(a.title || '')}" loading="lazy"${cropStyle ? ` style="${cropStyle}"` : ''}></div>
        </div>
        <p class="polaroid-caption">${escapeHtml(a.title || '')}</p>
      </article>`;
      }).join('\n      ') + '\n      ';

    html = inject(html, 'artworks', artworksHtml);

    // Events / dates
    const eventRots = ['-1.5deg', '1deg', '-0.5deg', '2deg', '-1deg', '0.5deg'];
    const eventsHtml = events.length === 0
      ? '\n      <p style="color: var(--text-light); font-family: var(--font-handwriting);">Aktuell keine Termine</p>\n      '
      : '\n      ' + events.map((e, i) => {
        const timeStr = e.time_start ? `\n        <span class="date-card__time">${escapeHtml(e.time_start)}${e.time_end ? ' – ' + escapeHtml(e.time_end) : ''}</span>` : '';
        return `<div class="date-card fade-in" style="--rot: ${eventRots[i % eventRots.length]};">
        <span class="date-card__date">${escapeHtml(formatDate(e.date))}</span>${timeStr}
        <span class="date-card__what">${escapeHtml(e.title)}</span>
        <span class="date-card__where">${escapeHtml(e.location || '')}</span>
      </div>`;
      }).join('\n      ') + '\n      ';

    html = inject(html, 'events', eventsHtml);

    return html;
  }

  // Process index.html
  let indexHtml = readFileSync(join(__dirname, 'index.html'), 'utf-8');
  indexHtml = applyContent(indexHtml);
  writeFileSync(join(__dirname, 'index.html'), indexHtml);
  console.log('✓ index.html updated');

  // Process admin.html
  let adminHtml = readFileSync(join(__dirname, 'admin.html'), 'utf-8');
  adminHtml = applyContent(adminHtml);
  writeFileSync(join(__dirname, 'admin.html'), adminHtml);
  console.log('✓ admin.html updated');

  console.log('✓ Build complete — content baked in from DB');
}

build().catch(err => {
  console.error('Build error (deploying with default content):', err.message);
  process.exit(0); // Don't block deploy if DB is temporarily unreachable
});

// Add-to-Relay popup: scrape the active tab for a business name + phone,
// prefill the form, and POST the lead to Relay's public capture endpoint.
const RELAY_BASE = 'https://tallyai-relay.netlify.app';

const $ = (id) => document.getElementById(id);

// Runs IN the page (via chrome.scripting) — must be self-contained.
function scrape() {
  const meta = (p) => document.querySelector(`meta[property="${p}"],meta[name="${p}"]`)?.content || '';
  const name =
    meta('og:site_name') ||
    (document.title || '').split(/[|\-–—·]/)[0].trim() ||
    document.querySelector('h1')?.innerText?.trim() ||
    '';
  const text = document.body ? document.body.innerText : '';
  const phoneMatch = text.match(/(\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/);
  // Rough "City, ST" pull from visible text.
  const cityMatch = text.match(/([A-Z][a-zA-Z.\s]+),\s*([A-Z]{2})\b/);
  return {
    name,
    phone: phoneMatch ? phoneMatch[0].trim() : '',
    city: cityMatch ? `${cityMatch[1].trim()}, ${cityMatch[2]}` : '',
    url: location.href,
  };
}

let pageUrl = '';

async function prefill() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: scrape });
    const d = res?.result || {};
    pageUrl = d.url || tab.url || '';
    if (d.name) $('salon').value = d.name;
    if (d.phone) $('phone').value = d.phone;
    if (d.city) $('city').value = d.city;
  } catch (e) {
    // Some pages (chrome://, web store) block scripting — user can type manually.
    pageUrl = '';
  }
}

function showMsg(kind, text) {
  const el = $('msg');
  el.className = `msg ${kind}`;
  el.textContent = text;
}

async function add() {
  const salon = $('salon').value.trim();
  const phone = $('phone').value.trim();
  const city = $('city').value.trim();
  if (!salon) { showMsg('err', 'Add a salon name first.'); return; }
  if (!phone) { showMsg('err', 'Add a phone number first.'); return; }

  const btn = $('add');
  btn.disabled = true; btn.textContent = 'Adding…'; showMsg('', '');
  try {
    const r = await fetch(`${RELAY_BASE}/api/leads/capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ salon, phone, city, source: 'extension', stage: 'new', notes: pageUrl ? `Found at ${pageUrl}` : '' }),
    });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || 'Could not save.'); }
    $('root').innerHTML =
      `<div class="done"><div class="tick">✓</div>` +
      `<div style="font-weight:700;font-size:15px;margin-bottom:4px">Added to Relay</div>` +
      `<div style="font-size:12.5px;color:#64748b">${salon} is now a new lead.</div>` +
      `<div style="margin-top:12px"><a href="${RELAY_BASE}" target="_blank">Open Relay →</a></div></div>`;
  } catch (e) {
    btn.disabled = false; btn.textContent = 'Add to Relay';
    showMsg('err', e.message || 'Could not save.');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  prefill();
  $('add').addEventListener('click', add);
});

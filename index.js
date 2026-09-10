// ============================================================
//  MIRROR PAWN — Discord poster
//  Poller Supabase for nye salg og hændelser og sender dem til
//  en Discord-kanal via webhook. Kør den på en gratis host
//  (Railway / Render / din egen PC). Se GUIDE.md.
// ============================================================

const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_KEY      = process.env.SUPABASE_SERVICE_KEY; // service_role-nøgle
const DISCORD_WEBHOOK   = process.env.DISCORD_WEBHOOK_URL;
const POLL_MS           = 8000;
const CUR               = process.env.CURRENCY || "kr.";

if (!SUPABASE_URL || !SUPABASE_KEY || !DISCORD_WEBHOOK) {
  console.error("Mangler miljøvariabler: SUPABASE_URL, SUPABASE_SERVICE_KEY, DISCORD_WEBHOOK_URL");
  process.exit(1);
}

const fmt = (n) => Math.round(+n || 0).toLocaleString("da-DK");
const H = { "Content-Type": "application/json", apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

async function sb(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

async function sendDiscord(embed) {
  const r = await fetch(DISCORD_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed] }),
  });
  if (!r.ok && r.status !== 204) console.error("Discord-fejl:", r.status, await r.text());
}

const GOLD = 0xf5b301, GREEN = 0x2e7d32, BLUE = 0x1f3864;

function saleEmbed(s) {
  const items = (s.lines || []).map((l) => `${l.qty}× ${l.name}`).join(" · ") || "—";
  const fields = [
    { name: "Udbetalt", value: `**${fmt(s.total)} ${CUR}**`, inline: true },
    { name: "Avance", value: `${fmt(s.profit)} ${CUR}`, inline: true },
  ];
  if (s.cust_id) fields.push({ name: "Kunde-ID", value: `\`${s.cust_id}\` (+${s.points}p)`, inline: true });
  if (s.seller_name) {
    const comm = +s.commission || 0;
    fields.push({ name: "Sælger", value: comm > 0 ? `${s.seller_name} (+${fmt(comm)} ${CUR} i provision)` : s.seller_name, inline: true });
  }
  return {
    title: "💰 Nyt salg",
    color: GREEN,
    description: items,
    fields,
    timestamp: s.at,
    footer: { text: "Mirror Pawn" },
  };
}

function eventEmbed(e) {
  const p = e.payload || {};
  if (e.kind === "levelup")
    return { title: "🏆 Niveau-skift", color: GOLD, timestamp: e.at, footer: { text: "Mirror Pawn" },
      description: `Kunde \`${p.custId}\` er nu **${p.level}** (${p.points} point)` };
  if (e.kind === "newcustomer")
    return { title: "✨ Ny kunde", color: BLUE, timestamp: e.at, footer: { text: "Mirror Pawn" },
      description: `Første handel registreret for \`${p.custId}\`` };
  if (e.kind === "price")
    return { title: "🏷️ Priser opdateret", color: BLUE, timestamp: e.at, footer: { text: "Mirror Pawn" },
      description: p.summary || "En eller flere priser blev ændret." };
  return { title: e.kind, color: BLUE, timestamp: e.at, description: JSON.stringify(p).slice(0, 500) };
}

async function tick() {
  try {
    // 1) upostede salg (ældste først)
    const sales = await sb(`sales?posted=eq.false&order=at.asc&limit=10`);
    for (const s of sales) {
      await sendDiscord(saleEmbed(s));
      await sb(`sales?id=eq.${s.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ posted: true }) });
    }
    // 2) upostede hændelser
    const events = await sb(`events?posted=eq.false&order=at.asc&limit=10`);
    for (const e of events) {
      await sendDiscord(eventEmbed(e));
      await sb(`events?id=eq.${e.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ posted: true }) });
    }
    if (sales.length || events.length) console.log(`Postet ${sales.length} salg, ${events.length} hændelser.`);
  } catch (err) {
    console.error("tick-fejl:", err.message);
  }
}

console.log("Mirror Pawn Discord-poster kører…");
tick();
setInterval(tick, POLL_MS);

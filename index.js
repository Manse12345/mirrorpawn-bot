// ============================================================
//  MIRROR PAWN — Discord poster
//  Poller Supabase for nye salg og hændelser og sender dem til
//  en Discord-kanal via webhook. Kør den på en gratis host
//  (Railway / Render / din egen PC). Se GUIDE.md.
// ============================================================

const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_KEY      = process.env.SUPABASE_SERVICE_KEY; // service_role-nøgle
const DISCORD_WEBHOOK   = process.env.DISCORD_WEBHOOK_URL;
// Separat webhook til vagt-stemplinger (ind/ud) — egen Discord-kanal, adskilt fra
// salg/hændelser ovenfor. Valgfri: er den ikke sat, springer botten blot
// vagt-postering over (se shiftTick nedenfor) uden at det rører salg-posteringen.
const VAGT_WEBHOOK      = process.env.VAGT_WEBHOOK_URL;
const POLL_MS           = 8000;
const CUR               = process.env.CURRENCY || "kr.";

if (!SUPABASE_URL || !SUPABASE_KEY || !DISCORD_WEBHOOK) {
  console.error("Mangler miljøvariabler: SUPABASE_URL, SUPABASE_SERVICE_KEY, DISCORD_WEBHOOK_URL");
  process.exit(1);
}
if (!VAGT_WEBHOOK) {
  console.warn("VAGT_WEBHOOK_URL er ikke sat — vagt-ind/ud postes IKKE til Discord (salg/hændelser postes som normalt).");
}

const fmt = (n) => Math.round(+n || 0).toLocaleString("da-DK");
const H = { "Content-Type": "application/json", apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

async function sb(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

// Sender en rå webhook-payload (bruges af påmindelsen nedenfor, som har brug for
// "content" + "allowed_mentions" ud over selve embeddet, for at et @ping reelt
// trigger en Discord-notifikation — et ping INDE I et embed pinger IKKE nogen).
async function sendDiscordPayload(webhookUrl, payload) {
  const r = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok && r.status !== 204) console.error("Discord-fejl:", r.status, await r.text());
}
// Tager selve webhook-URL'en som parameter, så salg/hændelser (DISCORD_WEBHOOK) og
// vagt-stemplinger (VAGT_WEBHOOK) kan poste til to forskellige Discord-kanaler med
// samme underliggende funktion. sendDiscord(...) nedenfor er den UÆNDREDE genvej,
// som salg/hændelser stadig bruger, så den postering er 100% som før.
const sendDiscordTo = (webhookUrl, embed) => sendDiscordPayload(webhookUrl, { embeds: [embed] });
const sendDiscord = (embed) => sendDiscordTo(DISCORD_WEBHOOK, embed);

const GOLD = 0xf5b301, GREEN = 0x2e7d32, BLUE = 0x1f3864, RED = 0xc0392b, ORANGE = 0xe67e22;
// Ingen aktivitet (handel) i dette antal ms, mens man er på vagt → påmindelse om at stemple ud.
const REMINDER_MS = 45 * 60 * 1000;

// Formaterer varelinjerne som en pæn, læsbar kvitteringsblok (antal, pris pr. stk. og
// linjetotal) i stedet for én rå tekstlinje. Discord-felter har en grænse på 1024 tegn,
// så en meget lang handel skæres af med "…" i stedet for at fejle hele postningen.
function formatItemLines(lines) {
  if (!lines || !lines.length) return "—";
  const text = lines
    .map((l) => {
      const qty = +l.qty || 0;
      const sum = +l.sum || 0;
      const unitPrice = qty ? Math.round(sum / qty) : +l.price || 0;
      return `${qty}× ${l.name} — ${fmt(unitPrice)} ${CUR}/stk. (${fmt(sum)} ${CUR})`;
    })
    .join("\n");
  return text.length > 1000 ? text.slice(0, 1000) + "\n…" : text;
}

function saleEmbed(s) {
  const isSell = s.type === "sell";
  const dt = new Date(s.at);
  const dateStr = `${dt.toLocaleDateString("da-DK")} ${dt.toTimeString().slice(0, 5)}`;

  const fields = [{ name: "Dato/tid", value: dateStr, inline: true }];
  if (s.cust_id) fields.push({ name: "Kunde-ID", value: `\`${s.cust_id}\`${s.points ? ` (+${s.points}p)` : ""}`, inline: true });
  fields.push({ name: "Varer", value: formatItemLines(s.lines) });
  fields.push(
    isSell
      ? { name: "Modtaget (total)", value: `**${fmt(s.total)} ${CUR}**`, inline: true }
      : { name: "Udbetalt (total)", value: `**${fmt(s.total)} ${CUR}**`, inline: true }
  );
  fields.push({ name: isSell ? "Fortjeneste" : "Avance", value: `${fmt(s.profit)} ${CUR}`, inline: true });
  if (s.seller_name) {
    const comm = +s.commission || 0;
    fields.push({ name: "Sælger", value: comm > 0 ? `${s.seller_name} (+${fmt(comm)} ${CUR} i provision)` : s.seller_name, inline: true });
  }
  return {
    title: isSell ? "🏷️ Vare solgt" : "💰 Nyt køb",
    color: isSell ? GREEN : GOLD,
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

// Navnet på den, der stemplede — "shifts" gemmer ikke navnet selv (kun user_id), så
// det hentes med et PostgREST-embed af "profiles" via foreign key-relationen (samme
// join som appens loadActiveShifts/loadShiftLog i supabase-store.js bruger).
const shiftPersonName = (s) => s.profiles?.name || "Ukendt medarbejder";

function shiftInEmbed(s) {
  const dt = new Date(s.clock_in);
  const dateStr = `${dt.toLocaleDateString("da-DK")} ${dt.toTimeString().slice(0, 5)}`;
  return {
    title: `🟢 ${shiftPersonName(s)} stemplede IND`,
    color: GREEN,
    fields: [{ name: "Tidspunkt", value: dateStr, inline: true }],
    timestamp: s.clock_in,
    footer: { text: "Mirror Pawn · Vagt" },
  };
}

function shiftOutEmbed(s) {
  const inDt = new Date(s.clock_in), outDt = new Date(s.clock_out);
  const dateStr = `${outDt.toLocaleDateString("da-DK")} ${outDt.toTimeString().slice(0, 5)}`;
  const durMin = Math.max(0, Math.round((outDt - inDt) / 60000));
  const durStr = `${Math.floor(durMin / 60)}t ${durMin % 60}m`;
  return {
    title: `🔴 ${shiftPersonName(s)} stemplede UD`,
    color: RED,
    fields: [
      { name: "Tidspunkt", value: dateStr, inline: true },
      { name: "Varighed", value: durStr, inline: true },
    ],
    timestamp: s.clock_out,
    footer: { text: "Mirror Pawn · Vagt" },
  };
}

function reminderEmbed(name, mention) {
  const who = mention || `**${name}**`;
  return {
    title: "⏰ Husk at stemple ud?",
    color: ORANGE,
    description: `${who} — du har ikke lavet en handel i 45 min. Er du stadig på arbejde? Husk at stemple ud hvis du holder fri.`,
    timestamp: new Date().toISOString(),
    footer: { text: "Mirror Pawn · Vagt" },
  };
}

// Tjekker hver ÅBNE vagt (clock_out er tom) for inaktivitet: findes der en handel
// (matchet på seller_id = shifts.user_id) fra EFTER personen stemplede ind, bruges
// tidspunktet for den seneste af dem som "uret" — ellers bruges selve ind-stemplings-
// tidspunktet. Går der 45 min uden at "uret" har rykket sig, og er der ikke allerede
// sendt en påmindelse for PRÆCIS dette aktivitetstidspunkt (last_reminder_at >=
// aktivitetstidspunkt = allerede påmindet, ingen ny handel siden), sendes én
// påmindelse, og last_reminder_at sættes til nu. Laver personen en ny handel bagefter,
// rykker "uret" sig forbi last_reminder_at igen, og en ny påmindelse kan sendes efter
// endnu 45 min uden aktivitet — helt automatisk, uden separat "nulstil"-kald nogen
// steder. Rører ALDRIG selve handlen/kassen/lageret — læser kun sales.at og seller_id.
async function reminderTick() {
  const openShifts = await sb(`shifts?select=id,user_id,clock_in,last_reminder_at,profiles(name,discord_id)&clock_out=is.null`);
  let sent = 0;
  const now = Date.now();
  for (const s of openShifts) {
    const clockInMs = new Date(s.clock_in).getTime();
    const lastSale = await sb(
      `sales?select=at&seller_id=eq.${encodeURIComponent(s.user_id)}&at=gte.${encodeURIComponent(s.clock_in)}&order=at.desc&limit=1`
    );
    const lastActivityMs = lastSale.length ? new Date(lastSale[0].at).getTime() : clockInMs;
    const alreadyReminded = s.last_reminder_at && new Date(s.last_reminder_at).getTime() >= lastActivityMs;
    if (now - lastActivityMs < REMINDER_MS || alreadyReminded) continue;

    const name = s.profiles?.name || "Ukendt medarbejder";
    const discordId = s.profiles?.discord_id;
    const mention = discordId ? `<@${discordId}>` : "";
    await sendDiscordPayload(VAGT_WEBHOOK, {
      content: mention, // det er DENNE linje, ikke embeddet, der får Discord til reelt at pinge
      embeds: [reminderEmbed(name, mention)],
      allowed_mentions: discordId ? { users: [discordId] } : { parse: [] },
    });
    await sb(`shifts?id=eq.${s.id}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ last_reminder_at: new Date(now).toISOString() }),
    });
    sent++;
  }
  return sent;
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

    // 3) vagt-ind/ud (kræver VAGT_WEBHOOK_URL og migrationen 15-shift-discord-posting.sql
    // — bruger samme "posted"-flag-mønster som salg/hændelser ovenfor, blot to flag pr.
    // vagt, fordi en vagt har to hændelser (ind og ud) på forskellige tidspunkter).
    if (VAGT_WEBHOOK) {
      const clockedIn = await sb(`shifts?select=id,user_id,clock_in,clock_out,profiles(name)&posted_in=eq.false&order=clock_in.asc&limit=10`);
      for (const s of clockedIn) {
        await sendDiscordTo(VAGT_WEBHOOK, shiftInEmbed(s));
        await sb(`shifts?id=eq.${s.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ posted_in: true }) });
      }
      const clockedOut = await sb(`shifts?select=id,user_id,clock_in,clock_out,profiles(name)&clock_out=not.is.null&posted_out=eq.false&order=clock_out.asc&limit=10`);
      for (const s of clockedOut) {
        await sendDiscordTo(VAGT_WEBHOOK, shiftOutEmbed(s));
        await sb(`shifts?id=eq.${s.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ posted_out: true }) });
      }
      if (clockedIn.length || clockedOut.length) console.log(`Postet ${clockedIn.length} ind-stemplinger, ${clockedOut.length} ud-stemplinger.`);

      // 4) inaktivitets-påmindelse (kræver VAGT_WEBHOOK_URL, samme kanal som ind/ud
      // ovenfor, og migrationen 17-shift-inactivity-reminder.sql)
      const reminded = await reminderTick();
      if (reminded) console.log(`Sendt ${reminded} inaktivitets-påmindelse(r).`);
    }
  } catch (err) {
    console.error("tick-fejl:", err.message);
  }
}

console.log("Mirror Pawn Discord-poster kører…");
tick();
setInterval(tick, POLL_MS);

// ============================================================
//  MIRROR PAWN — Discord-bot
//  To ting i én proces:
//   1) Salg/hændelser: poller Supabase og poster dem via en almindelig Discord
//      WEBHOOK (DISCORD_WEBHOOK_URL) — UÆNDRET fra før.
//   2) Vagt (ind/ud, 45-min-påmindelse med knap, auto-udstempling ved 15 min uden
//      svar): kører nu som en RIGTIG gateway-bot (discord.js), fordi en knap, man
//      kan trykke på, kræver en bot-applikation, der kan modtage tryk — en
//      webhook kan ikke det. Postes i VAGT_CHANNEL_ID via bottens egen klient.
//  Kør den på en gratis host (Railway / Render / din egen PC). Se GUIDE.md.
// ============================================================
import { Client, GatewayIntentBits, Events, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from "discord.js";

const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_KEY      = process.env.SUPABASE_SERVICE_KEY; // service_role-nøgle
const DISCORD_WEBHOOK   = process.env.DISCORD_WEBHOOK_URL;  // salg/hændelser — uændret
const POLL_MS           = 8000;
const CUR                = process.env.CURRENCY || "kr.";

// Ny bot-opsætning til vagt-delen. Alle tre kræves samtidig for at slå
// vagt-ind/ud, påmindelser og auto-udstempling til — mangler én, kører botten
// videre med salg/hændelser (webhook) som altid, men springer vagt-delen over,
// i stedet for at crashe hele processen.
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_GUILD_ID  = process.env.DISCORD_GUILD_ID;
const VAGT_CHANNEL_ID   = process.env.VAGT_CHANNEL_ID;
const VAGT_ENABLED      = !!(DISCORD_BOT_TOKEN && DISCORD_GUILD_ID && VAGT_CHANNEL_ID);

const REMINDER_MS = 45 * 60 * 1000; // ingen handel i 45 min → påmindelse
const CONFIRM_MS  = 15 * 60 * 1000; // intet knap-tryk i 15 min efter påmindelsen → auto-udstempling

if (!SUPABASE_URL || !SUPABASE_KEY || !DISCORD_WEBHOOK) {
  console.error("Mangler miljøvariabler: SUPABASE_URL, SUPABASE_SERVICE_KEY, DISCORD_WEBHOOK_URL");
  process.exit(1);
}
if (!VAGT_ENABLED) {
  console.warn(
    "DISCORD_BOT_TOKEN/DISCORD_GUILD_ID/VAGT_CHANNEL_ID er ikke alle sat — vagt-ind/ud, " +
    "45-min-påmindelse og auto-udstempling er SLÅET FRA. Salg/hændelser postes som normalt via webhook."
  );
}

const fmt = (n) => Math.round(+n || 0).toLocaleString("da-DK");
const H = { "Content-Type": "application/json", apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };

async function sb(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

// ---- Webhook-postering (KUN salg/hændelser — uændret opførsel) ----
async function sendDiscord(embed) {
  const r = await fetch(DISCORD_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed] }),
  });
  if (!r.ok && r.status !== 204) console.error("Discord-fejl:", r.status, await r.text());
}

const GOLD = 0xf5b301, GREEN = 0x2e7d32, BLUE = 0x1f3864, RED = 0xc0392b, ORANGE = 0xe67e22;

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

// ---- Vagt-embeds (postes nu via bot-klienten, se vagtChannel.send nedenfor) ----
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
    footer: { text: "Mirror Pawn · Vagt · Bekræft inden 15 min, ellers stemples du automatisk ud" },
    timestamp: new Date().toISOString(),
  };
}

function confirmedEmbed(name, atMs) {
  const t = new Date(atMs).toTimeString().slice(0, 5);
  return {
    title: "✅ Bekræftet",
    color: GREEN,
    description: `**${name}** bekræftede kl. ${t} — stadig på arbejde.`,
    footer: { text: "Mirror Pawn · Vagt" },
    timestamp: new Date(atMs).toISOString(),
  };
}

function autoClockoutEmbed(name, clockOutMs, clockInMs) {
  const outDt = new Date(clockOutMs);
  const dateStr = outDt.toLocaleDateString("da-DK");
  const timeStr = outDt.toTimeString().slice(0, 5);
  const durMin = Math.max(0, Math.round((clockOutMs - clockInMs) / 60000));
  const durStr = `${Math.floor(durMin / 60)}t ${durMin % 60}m`;
  return {
    title: "🔴 Automatisk udstemplet",
    color: RED,
    description: `**${name}** blev automatisk stemplet ud (ingen aktivitet). Vagt afsluttet kl. ${timeStr} (sidste handel).`,
    fields: [
      { name: "Dato", value: dateStr, inline: true },
      { name: "Varighed", value: durStr, inline: true },
    ],
    footer: { text: "Mirror Pawn · Vagt · Automatisk" },
    timestamp: new Date(clockOutMs).toISOString(),
  };
}

// ============================================================
//  Discord-bot-klient (kun oprettet/logget ind hvis VAGT_ENABLED)
// ============================================================
let vagtChannel = null;
let client = null;

if (VAGT_ENABLED) {
  client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once(Events.ClientReady, async (c) => {
    console.log(`Discord-bot logget ind som ${c.user.tag}.`);
    try {
      const channel = await c.channels.fetch(VAGT_CHANNEL_ID);
      if (!channel || channel.guildId !== DISCORD_GUILD_ID) {
        console.error("VAGT_CHANNEL_ID findes ikke i den forventede server (DISCORD_GUILD_ID) — vagt-postering forbliver slået fra.");
        return;
      }
      vagtChannel = channel;
      console.log(`Vagt-kanal klar: #${channel.name}.`);
    } catch (e) {
      console.error("Kunne ikke hente VAGT_CHANNEL_ID:", e.message);
    }
  });

  // "✅ Jeg er stadig på arbejde"-knappen fra en påmindelse. Kun personen, vagten
  // faktisk tilhører (matchet på deres eget discord_id i profiles), må bruge sin
  // egen knap — se tjekket nedenfor. Rører ALDRIG kasse/lager/handler/point,
  // udelukkende "shifts.confirmed_at" (+ rydder den pågående påmindelse).
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton() || !interaction.customId.startsWith("confirm_shift:")) return;
    const shiftId = interaction.customId.split(":")[1];
    try {
      const rows = await sb(`shifts?id=eq.${shiftId}&select=id,clock_out,profiles(name,discord_id)`);
      const shift = rows[0];
      if (!shift || shift.clock_out) {
        await interaction.reply({ content: "Denne vagt er allerede afsluttet.", flags: MessageFlags.Ephemeral });
        return;
      }
      const ownerDiscordId = shift.profiles?.discord_id;
      if (!ownerDiscordId || ownerDiscordId !== interaction.user.id) {
        await interaction.reply({ content: "Denne knap er ikke til dig.", flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.deferUpdate();
      const now = Date.now();
      await sb(`shifts?id=eq.${shiftId}`, {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ confirmed_at: new Date(now).toISOString(), reminder_sent_at: null, reminder_message_id: null }),
      });
      await interaction.editReply({ embeds: [confirmedEmbed(shift.profiles?.name || "Ukendt medarbejder", now)], components: [] });
    } catch (err) {
      console.error("interaction-fejl:", err.message);
    }
  });

  client.login(DISCORD_BOT_TOKEN).catch((e) => console.error("Discord-bot login fejlede:", e.message));
}

// Sender én påmindelse med knap for en inaktiv, åben vagt og noterer i databasen,
// at den nu afventer svar (reminder_sent_at/reminder_message_id).
async function sendReminder(s) {
  const name = shiftPersonName(s);
  const discordId = s.profiles?.discord_id;
  const mention = discordId ? `<@${discordId}>` : "";
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`confirm_shift:${s.id}`).setLabel("✅ Jeg er stadig på arbejde").setStyle(ButtonStyle.Success)
  );
  const msg = await vagtChannel.send({
    content: mention, // det er DENNE linje, ikke embeddet, der reelt trigger et Discord-ping
    embeds: [reminderEmbed(name, mention)],
    components: [row],
    allowedMentions: discordId ? { users: [discordId] } : { parse: [] },
  });
  await sb(`shifts?id=eq.${s.id}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ reminder_sent_at: new Date().toISOString(), reminder_message_id: msg.id }),
  });
}

// Stempler en inaktiv vagt automatisk ud: clock_out sættes TILBAGE til personens
// seneste handel (eller ind-stemplingen, hvis de aldrig nåede at handle) — ikke til
// "nu" — og markeres auto_closed = true, så ejeren kan se forskel i vagtloggen.
// posted_out sættes samtidig til true, så den ALMINDELIGE "stemplede UD"-besked
// ikke ALSO postes for denne vagt (kun ÉN besked pr. udstempling).
async function autoClockOut(s, effectiveClockOutMs, clockInMs) {
  const name = shiftPersonName(s);
  await sb(`shifts?id=eq.${s.id}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      clock_out: new Date(effectiveClockOutMs).toISOString(),
      auto_closed: true,
      posted_out: true,
      reminder_sent_at: null,
      reminder_message_id: null,
    }),
  });
  if (s.reminder_message_id) {
    try {
      const msg = await vagtChannel.messages.fetch(s.reminder_message_id);
      await msg.edit({ components: [] }); // fjern knappen — for sent at bekræfte nu
    } catch (e) { /* beskeden kan være slettet manuelt i kanalen — ikke kritisk */ }
  }
  await vagtChannel.send({ embeds: [autoClockoutEmbed(name, effectiveClockOutMs, clockInMs)] });
}

// Tjekker hver ÅBNE vagt for inaktivitet. "Aktivitet" = det seneste af: en handel
// (matchet på sales.seller_id = shifts.user_id, FRA ind-stemplingen og frem) eller
// et knap-tryk (confirmed_at) — begge "nulstiller uret" på samme måde. Tre udfald
// pr. vagt pr. tjek:
//   - Ingen påmindelse afventer, og der er gået ≥45 min siden sidste aktivitet →
//     send én påmindelse med knap.
//   - En påmindelse afventer, men der ER sket ny aktivitet siden den blev sendt
//     (en handel — et knap-tryk rydder allerede påmindelsen med det samme, se
//     InteractionCreate ovenfor) → påmindelsen er forældet, ryd den, intet postes.
//   - En påmindelse afventer FORTSAT uden ny aktivitet, og der er gået ≥15 min
//     siden den blev sendt → automatisk udstempling.
// Alt andet: vent til næste tjek. Præcis ÉN handling pr. vagt pr. inaktivitets-
// periode — ny handel/bekræftelse nulstiller alt, så en ny påmindelse kan komme
// igen efter endnu 45 min.
async function reminderTick() {
  if (!vagtChannel) return { reminders: 0, autoClosed: 0 };
  const openShifts = await sb(
    `shifts?select=id,user_id,clock_in,confirmed_at,reminder_sent_at,reminder_message_id,profiles(name,discord_id)&clock_out=is.null`
  );
  const now = Date.now();
  let reminders = 0, autoClosed = 0;

  for (const s of openShifts) {
    const clockInMs = new Date(s.clock_in).getTime();
    const lastSale = await sb(
      `sales?select=at&seller_id=eq.${encodeURIComponent(s.user_id)}&at=gte.${encodeURIComponent(s.clock_in)}&order=at.desc&limit=1`
    );
    const lastSaleMs = lastSale.length ? new Date(lastSale[0].at).getTime() : 0;
    const confirmedMs = s.confirmed_at ? new Date(s.confirmed_at).getTime() : 0;
    const lastActivityMs = Math.max(clockInMs, lastSaleMs, confirmedMs);

    if (s.reminder_sent_at) {
      const reminderSentMs = new Date(s.reminder_sent_at).getTime();
      if (lastActivityMs > reminderSentMs) {
        // Ny handel er kommet ind, siden påmindelsen blev sendt — forældet, ryd den.
        await sb(`shifts?id=eq.${s.id}`, {
          method: "PATCH", headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ reminder_sent_at: null, reminder_message_id: null }),
        });
        continue;
      }
      if (now - reminderSentMs >= CONFIRM_MS) {
        await autoClockOut(s, lastActivityMs, clockInMs);
        autoClosed++;
      }
      continue; // afventer stadig svar/udløb — ingen ny påmindelse ovenpå denne
    }

    if (now - lastActivityMs >= REMINDER_MS) {
      await sendReminder(s);
      reminders++;
    }
  }
  return { reminders, autoClosed };
}

async function tick() {
  try {
    // 1) upostede salg (ældste først) — webhook, uændret
    const sales = await sb(`sales?posted=eq.false&order=at.asc&limit=10`);
    for (const s of sales) {
      await sendDiscord(saleEmbed(s));
      await sb(`sales?id=eq.${s.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ posted: true }) });
    }
    // 2) upostede hændelser — webhook, uændret
    const events = await sb(`events?posted=eq.false&order=at.asc&limit=10`);
    for (const e of events) {
      await sendDiscord(eventEmbed(e));
      await sb(`events?id=eq.${e.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ posted: true }) });
    }
    if (sales.length || events.length) console.log(`Postet ${sales.length} salg, ${events.length} hændelser.`);

    // 3) vagt-ind/ud + 4) påmindelse/auto-udstempling — kun når bot-klienten er
    // logget ind OG har fundet vagt-kanalen (se Events.ClientReady ovenfor).
    if (VAGT_ENABLED && vagtChannel) {
      const clockedIn = await sb(`shifts?select=id,user_id,clock_in,clock_out,profiles(name)&posted_in=eq.false&order=clock_in.asc&limit=10`);
      for (const s of clockedIn) {
        await vagtChannel.send({ embeds: [shiftInEmbed(s)] });
        await sb(`shifts?id=eq.${s.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ posted_in: true }) });
      }
      const clockedOut = await sb(`shifts?select=id,user_id,clock_in,clock_out,profiles(name)&clock_out=not.is.null&posted_out=eq.false&order=clock_out.asc&limit=10`);
      for (const s of clockedOut) {
        await vagtChannel.send({ embeds: [shiftOutEmbed(s)] });
        await sb(`shifts?id=eq.${s.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ posted_out: true }) });
      }
      if (clockedIn.length || clockedOut.length) console.log(`Postet ${clockedIn.length} ind-stemplinger, ${clockedOut.length} ud-stemplinger.`);

      const { reminders, autoClosed } = await reminderTick();
      if (reminders || autoClosed) console.log(`${reminders} påmindelse(r) sendt, ${autoClosed} automatisk udstemplet.`);
    }
  } catch (err) {
    console.error("tick-fejl:", err.message);
  }
}

console.log("Mirror Pawn Discord-poster kører…");
tick();
setInterval(tick, POLL_MS);

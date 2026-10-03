import 'dotenv/config';

import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  AttachmentBuilder,
  MessageFlags,
  PermissionFlagsBits
} from 'discord.js';

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

const required = [
  'DISCORD_TOKEN',
  'CLIENT_ID',
  'GUILD_ID',
  'EGG_HEIST_CHANNEL_ID',
  'EGG_HEIST_ROLE_ID',
  'EUROPE_ROLE_ID',
  'AMERICAS_ROLE_ID',
  'APAC_ROLE_ID',
  'PROFILE_CHANNEL_ID'
];

for (const name of required) {
  if (!process.env[name]) {
    throw new Error(`Missing environment variable: ${name}`);
  }
}

fs.mkdirSync('./data', { recursive: true });

const db = new DatabaseSync('./data/egg-heist.sqlite');

db.exec(`
    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT UNIQUE,
      channel_id TEXT NOT NULL,
      creator_id TEXT NOT NULL,
      nickname TEXT NOT NULL,
      servers TEXT NOT NULL,
      difficulties TEXT NOT NULL,
      comment TEXT,
      scheduled_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      mode TEXT NOT NULL DEFAULT 'eggheist'
    );

    CREATE TABLE IF NOT EXISTS participants (
      request_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      joined_at INTEGER NOT NULL,
      PRIMARY KEY (request_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      nickname TEXT NOT NULL,
      aniimo_id TEXT NOT NULL,
      servers TEXT NOT NULL,
      level TEXT NOT NULL,
      about TEXT NOT NULL,
      message_id TEXT,
      photo_url TEXT,
      created_at INTEGER NOT NULL
    );
  `);

  try {
    db.exec(`
      ALTER TABLE requests
      ADD COLUMN mode TEXT NOT NULL DEFAULT 'eggheist'
    `);
  } catch (error) {
    if (!String(error.message).includes('duplicate column name')) {
      throw error;
    }
  }

const CONFIG = {
  channelId: process.env.EGG_HEIST_CHANNEL_ID,

  roles: {
    egg: process.env.EGG_HEIST_ROLE_ID,
    Europe: process.env.EUROPE_ROLE_ID,
    Americas: process.env.AMERICAS_ROLE_ID,
    Apac: process.env.APAC_ROLE_ID
  }
};

const SERVERS = [
  {
    value: 'Europe',
    label: 'Aniimo-Europe'
  },
  {
    value: 'Americas',
    label: 'Aniimo-Americas'
  },
  {
    value: 'Apac',
    label: 'Aniimo-Apac'
  }
];

const DIFFICULTIES = [
  'Normal',
  'Hard',
  'Nightmare',
  'Chaos'
];

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const pending = new Map();

const pendingProfiles = new Map();

const waitingForProfilePhoto = new Map();


/* =========================================================
   DATABASE HELPERS
   ========================================================= */

function getRequest(id) {
  return db
    .prepare('SELECT * FROM requests WHERE id = ?')
    .get(id);
}

function getParticipants(id) {
  return db
    .prepare(`
      SELECT user_id
      FROM participants
      WHERE request_id = ?
      ORDER BY joined_at ASC
    `)
    .all(id)
    .map(row => row.user_id);
}

function getTeamParticipants(request) {
  const allParticipants =
    getParticipants(request.id);

  const requestMode =
    request.mode || 'eggheist';

  const maxPlayers =
    requestMode === 'holobattle'
      ? 4
      : 3;

  const maxReserve = 2;

  return {
    main: allParticipants.slice(
      0,
      maxPlayers
    ),

    reserve: allParticipants.slice(
      maxPlayers,
      maxPlayers + maxReserve
    )
  };
}

function parseKyivDateTime(dateText, timeText) {

  const dateMatch = dateText.match(
    /^(\d{2})\.(\d{2})$/
  );

  const timeMatch = timeText.match(
    /^(\d{2}):(\d{2})$/
  );

  if (!dateMatch || !timeMatch) {
    return null;
  }

  const day = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  const todayParts = new Intl.DateTimeFormat(
    'en-US',
    {
      timeZone: 'Europe/Kyiv',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }
  ).formatToParts(
    new Date()
  );

  const getToday = type =>
    Number(
      todayParts.find(
        part => part.type === type
      )?.value
    );

  const currentYear =
    getToday('year');

  const currentMonth =
    getToday('month');

  const currentDay =
    getToday('day');

  for (
    let yearOffset = 0;
    yearOffset < 8;
    yearOffset++
  ) {

    const year =
      currentYear + yearOffset;

    const daysInMonth =
      new Date(
        Date.UTC(
          year,
          month,
          0
        )
      ).getUTCDate();

    if (day > daysInMonth) {
      continue;
    }

    if (
      yearOffset === 0 &&
      (
        month < currentMonth ||
        (
          month === currentMonth &&
          day < currentDay
        )
      )
    ) {
      continue;
    }

    const utcGuess =
      Date.UTC(
        year,
        month - 1,
        day,
        hour,
        minute
      );

    const getKyivOffset = timestamp => {

      const parts =
        new Intl.DateTimeFormat(
          'en-US',
          {
            timeZone: 'Europe/Kyiv',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hourCycle: 'h23'
          }
        ).formatToParts(
          new Date(timestamp)
        );

      const values = {};

      for (const part of parts) {
        if (part.type !== 'literal') {
          values[part.type] =
            Number(part.value);
        }
      }

      const localAsUtc =
        Date.UTC(
          values.year,
          values.month - 1,
          values.day,
          values.hour,
          values.minute,
          values.second
        );

      return localAsUtc - timestamp;
    };

    let timestamp =
      utcGuess -
      getKyivOffset(utcGuess);

    timestamp =
      utcGuess -
      getKyivOffset(timestamp);

    const check =
      new Intl.DateTimeFormat(
        'en-GB',
        {
          timeZone: 'Europe/Kyiv',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23'
        }
      ).formatToParts(
        new Date(timestamp)
      );

    const values = {};

    for (const part of check) {
      if (part.type !== 'literal') {
        values[part.type] =
          Number(part.value);
      }
    }

    if (
      values.year !== year ||
      values.month !== month ||
      values.day !== day ||
      values.hour !== hour ||
      values.minute !== minute
    ) {
      continue;
    }

    return timestamp;
  }

  return null;
}


function getHoloBattleWindow(scheduledAt) {
  const parts = new Intl.DateTimeFormat(
    'en-US',
    {
      timeZone: 'Asia/Singapore',
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }
  ).formatToParts(
    new Date(scheduledAt)
  );

  const get = type =>
    parts.find(
      part => part.type === type
    )?.value;

  const year = Number(get('year'));
  const month = Number(get('month'));
  const day = Number(get('day'));
  const hour = Number(get('hour'));
  const minute = Number(get('minute'));

  const weekdayMap = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6
  };

  const weekday =
    weekdayMap[get('weekday')];

  const currentMinutes =
    hour * 60 + minute;

  const startHour = 4 * 60;

  /*
   * Holo-Battle:
   * Thursday 04:00 UTC+8
   * until Monday 04:00 UTC+8
   */

  const isValid =
    (
      weekday === 4 &&
      currentMinutes >= startHour
    ) ||
    weekday === 5 ||
    weekday === 6 ||
    weekday === 0 ||
    (
      weekday === 1 &&
      currentMinutes < startHour
    );

  if (isValid) {
    return {
      valid: true,
      start: scheduledAt,
      end: scheduledAt
    };
  }

  let daysUntilThursday;

  if (weekday === 4) {
    daysUntilThursday = 0;
  } else if (weekday === 5) {
    daysUntilThursday = 6;
  } else if (weekday === 6) {
    daysUntilThursday = 5;
  } else if (weekday === 0) {
    daysUntilThursday = 4;
  } else if (weekday === 1) {
    daysUntilThursday = 3;
  } else if (weekday === 2) {
    daysUntilThursday = 2;
  } else {
    daysUntilThursday = 1;
  }

  /*
   * Convert the UTC+8 calendar date
   * into an actual UTC timestamp.
   */
  const date =
    new Date(
      Date.UTC(
        year,
        month - 1,
        day
      )
    );

  date.setUTCDate(
    date.getUTCDate() +
    daysUntilThursday
  );

  const start =
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      4 - 8,
      0,
      0,
      0
    );

  const endDate =
    new Date(start);

  endDate.setUTCDate(
    endDate.getUTCDate() +
    4
  );

  const end =
    endDate.getTime();

  return {
    valid: false,
    start,
    end
  };
}


function formatKyivDateTime(timestamp) {
  return new Intl.DateTimeFormat(
    'uk-UA',
    {
      timeZone: 'Europe/Kyiv',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }
  ).format(
    new Date(timestamp)
  );
}

function createRequest(data) {
  const result = db
    .prepare(`
      INSERT INTO requests
        (
          channel_id,
          creator_id,
          nickname,
          servers,
          difficulties,
          comment,
          scheduled_at,
          created_at
        )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      CONFIG.channelId,
      data.creatorId,
      data.nickname,
      JSON.stringify(data.servers),
      JSON.stringify(data.difficulties),
      data.comment || '',
      data.scheduledAt,
      Date.now()
    );

  const id = Number(
    result.lastInsertRowid
  );

  db.prepare(`
    INSERT INTO participants
      (
        request_id,
        user_id,
        joined_at
      )
    VALUES (?, ?, ?)
  `).run(
    id,
    data.creatorId,
    Date.now()
  );

  return id;
}

function createHoloBattleRequest(data) {
  const result = db
    .prepare(`
      INSERT INTO requests
        (
          channel_id,
          creator_id,
          nickname,
          servers,
          difficulties,
          comment,
          scheduled_at,
          created_at,
          mode
        )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      process.env.HOLO_BATTLE_CHANNEL_ID,
      data.creatorId,
      data.nickname,
      JSON.stringify(data.servers),
      JSON.stringify([]),
      data.comment || '',
      data.scheduledAt,
      Date.now(),
      'holobattle'
    );

  const id = Number(
    result.lastInsertRowid
  );

  db.prepare(`
    INSERT INTO participants
      (
        request_id,
        user_id,
        joined_at
      )
    VALUES (?, ?, ?)
  `).run(
    id,
    data.creatorId,
    Date.now()
  );

  return id;
}

function addParticipant(id, userId) {
  const request = getRequest(id);

  if (!request) {
    return {
      ok: false,
      reason: 'not_found'
    };
  }

  const participants =
    getParticipants(id);

  if (participants.includes(userId)) {
    return {
      ok: false,
      reason: 'already_joined'
    };
  }

  const requestMode =
    request.mode || 'eggheist';

  const maxPlayers =
    requestMode === 'holobattle'
      ? 4
      : 3;

  const maxReserve = 2;

  const maxTotal =
    maxPlayers + maxReserve;

  if (participants.length >= maxTotal) {
    return {
      ok: false,
      reason: 'full'
    };
  }

  db.prepare(`
    INSERT INTO participants (
      request_id,
      user_id,
      joined_at
    )
    VALUES (?, ?, ?)
  `).run(
    id,
    userId,
    Date.now()
  );

  return {
    ok: true
  };
}

function removeParticipant(id, userId) {
  const result = db
    .prepare(`
      DELETE FROM participants
      WHERE request_id = ?
        AND user_id = ?
    `)
    .run(
      id,
      userId
    );

  return result.changes > 0;
}


/* =========================================================
   DISCORD MESSAGE HELPERS
   ========================================================= */

function roleMentions(servers) {
  return servers
    .map(server => {
      const roleId = CONFIG.roles[server];
      return roleId ? `<@&${roleId}>` : '';
    })
    .filter(Boolean)
    .join(' ');
}

function serverLabels(servers) {
  return servers
    .map(server => {
      const found = SERVERS.find(s => s.value === server);
      return found ? found.label : server;
    })
    .join(', ');
}

function buildRequestEmbed(request) {
  const team =
    getTeamParticipants(request);

  const maxPlayers = 3;
  const maxReserve = 2;

  const mainText =
    team.main.length > 0
      ? team.main
          .map(
            (userId, index) =>
              `${index + 1}. <@${userId}>`
          )
          .join('\n')
      : 'Поки що ніхто не приєднався.';

  const reserveText =
    team.reserve.length > 0
      ? team.reserve
          .map(
            (userId, index) =>
              `${index + 1}. <@${userId}>`
          )
          .join('\n')
      : 'Поки що ніхто не стоїть у резерві.';

  let servers = [];

  let difficulties = [];

  try {
    servers =
      JSON.parse(request.servers || '[]');
  } catch {
    servers = [];
  }

  try {
    difficulties =
      JSON.parse(request.difficulties || '[]');
  } catch {
    difficulties = [];
  }

  const serverText =
    servers.length > 0
      ? servers.join(', ')
      : '—';

  const difficultyText =
    difficulties.length > 0
      ? difficulties.join(', ')
      : '—';

  let dateText = '—';
  let timeText = '—';

  if (request.scheduled_at) {
    const scheduledDate =
      new Date(request.scheduled_at);

    dateText =
      scheduledDate.toLocaleDateString(
        'uk-UA',
        {
          timeZone: 'Europe/Kyiv',
          day: '2-digit',
          month: '2-digit'
        }
      );

    timeText =
      scheduledDate.toLocaleTimeString(
        'uk-UA',
        {
          timeZone: 'Europe/Kyiv',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false
        }
      );
  }

  const embed = new EmbedBuilder()
    .setTitle('🥚 Egg Heist — пошук групи')
    .setColor(0xF1C40F)
    .addFields(
      {
        name: '👤 Нікнейм',
        value: request.nickname || '—',
        inline: true
      },
      {
        name: '📅 Дата',
        value: dateText,
        inline: true
      },
      {
        name: '🕐 Час за Києвом',
        value: timeText,
        inline: true
      },
      {
        name: '🌐 Сервер',
        value: serverText,
        inline: false
      },
      {
        name: '⚔️ Складність',
        value: difficultyText,
        inline: false
      },
      {
        name: `👥 Основна група (${team.main.length}/${maxPlayers})`,
        value: mainText,
        inline: false
      },
      {
        name: `🪑 Резервна черга (${team.reserve.length}/${maxReserve})`,
        value: reserveText,
        inline: false
      },
      {
        name: '💬 Коментар',
        value: request.comment || '—',
        inline: false
      }
    );

  return embed;
}

function buildButtons(
  requestId,
  isFull,
  isFinished = false
) {
  return new ActionRowBuilder().addComponents(

    new ButtonBuilder()
      .setCustomId(
        `eh_join:${requestId}`
      )
      .setLabel(
        isFinished
          ? 'Збір завершено'
          : 'Приєднатися'
      )
      .setEmoji(
        isFinished
          ? '🔴'
          : '➕'
      )
      .setStyle(
        isFinished
          ? ButtonStyle.Secondary
          : ButtonStyle.Success
      )
      .setDisabled(
        isFull || isFinished
      ),

    new ButtonBuilder()
      .setCustomId(
        `eh_leave:${requestId}`
      )
      .setLabel('Вийти')
      .setEmoji('➖')
      .setStyle(
        ButtonStyle.Secondary
      ),

    new ButtonBuilder()
      .setCustomId(
        `delete_request:${requestId}`
      )
      .setLabel('Видалити')
      .setEmoji('🗑️')
      .setStyle(
        ButtonStyle.Danger
      )
  );
}

function buildHoloBattleButtons(
  requestId,
  isFull,
  isFinished = false
) {
  return new ActionRowBuilder().addComponents(

    new ButtonBuilder()
      .setCustomId(
        `hb_join:${requestId}`
      )
      .setLabel(
        isFinished
          ? 'Збір завершено'
          : 'Приєднатися'
      )
      .setEmoji(
        isFinished
          ? '🔴'
          : '➕'
      )
      .setStyle(
        isFinished
          ? ButtonStyle.Secondary
          : ButtonStyle.Success
      )
      .setDisabled(
        isFull || isFinished
      ),

    new ButtonBuilder()
      .setCustomId(
        `hb_leave:${requestId}`
      )
      .setLabel('Вийти')
      .setEmoji('➖')
      .setStyle(
        ButtonStyle.Secondary
      ),

    new ButtonBuilder()
      .setCustomId(
        `delete_request:${requestId}`
      )
      .setLabel('Видалити')
      .setEmoji('🗑️')
      .setStyle(
        ButtonStyle.Danger
      )
  );
}

function buildHoloBattleEmbed(request) {
  const team =
    getTeamParticipants(request);

  const maxPlayers = 4;
  const maxReserve = 2;

  const mainText =
    team.main.length > 0
      ? team.main
          .map(
            (userId, index) =>
              `${index + 1}. <@${userId}>`
          )
          .join('\n')
      : 'Поки що ніхто не приєднався.';

  const reserveText =
    team.reserve.length > 0
      ? team.reserve
          .map(
            (userId, index) =>
              `${index + 1}. <@${userId}>`
          )
          .join('\n')
      : 'Поки що ніхто не стоїть у резерві.';

  let dateText = '—';
  let timeText = '—';

  if (request.scheduled_at) {
    const scheduledDate =
      new Date(request.scheduled_at);

    dateText =
      scheduledDate.toLocaleDateString(
        'uk-UA',
        {
          timeZone: 'Europe/Kyiv',
          day: '2-digit',
          month: '2-digit'
        }
      );

    timeText =
      scheduledDate.toLocaleTimeString(
        'uk-UA',
        {
          timeZone: 'Europe/Kyiv',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false
        }
      );
  }

  const embed = new EmbedBuilder()
    .setTitle('⚔️ Holo-Battle — пошук групи')
    .setColor(0x9B59B6)
    .addFields(
      {
        name: '👤 Нікнейм',
        value: request.nickname || '—',
        inline: true
      },
      {
        name: '📅 Дата',
        value: dateText,
        inline: true
      },
      {
        name: '🕐 Час за Києвом',
        value: timeText,
        inline: true
      },
      {
        name: `👥 Основна група (${team.main.length}/${maxPlayers})`,
        value: mainText,
        inline: false
      },
      {
        name: `🪑 Резервна черга (${team.reserve.length}/${maxReserve})`,
        value: reserveText,
        inline: false
      },
      {
        name: '💬 Коментар',
        value: request.comment || '—',
        inline: false
      }
    );

  return embed;
}

async function refreshRequestMessage(requestId) {
  const request = getRequest(requestId);

  if (!request || !request.message_id) {
    return;
  }

  const channel =
    await client.channels.fetch(
      request.channel_id
    );

  if (!channel) {
    return;
  }

  let message;

  try {
    message = await channel.messages.fetch(
      request.message_id
    );
  } catch (error) {

    if (error.code === 10008) {
      return;
    }

    throw error;
  }

  if (!message) {
    return;
  }

  const participants =
    getParticipants(requestId);

  const maxPlayers = 3;
  const maxReserve = 2;
  const maxTotal =
    maxPlayers + maxReserve;

  const isFull =
    participants.length >= maxTotal;

  const isFinished =
    Date.now() >=
    request.scheduled_at + 60 * 60 * 1000;

  await message.edit({
    embeds: [
      buildRequestEmbed(request)
    ],
    components: [
      buildButtons(
        requestId,
        isFull,
        isFinished
      )
    ]
  });
}

async function refreshHoloBattleMessage(requestId) {
  const request = getRequest(requestId);

  if (!request || !request.message_id) {
    return;
  }

  const channel =
    await client.channels.fetch(
      request.channel_id
    );

  if (!channel) {
    return;
  }

  let message;

  try {
    message = await channel.messages.fetch(
      request.message_id
    );
  } catch (error) {

    if (error.code === 10008) {
      return;
    }

    throw error;
  }

  if (!message) {
    return;
  }

  const participants =
    getParticipants(requestId);

  const maxPlayers = 4;
  const maxReserve = 2;
  const maxTotal =
    maxPlayers + maxReserve;

  const isFull =
    participants.length >= maxTotal;

  const isFinished =
    Date.now() >=
    request.scheduled_at + 60 * 60 * 1000;

  await message.edit({
    embeds: [
      buildHoloBattleEmbed(request)
    ],
    components: [
      buildHoloBattleButtons(
        requestId,
        isFull,
        isFinished
      )
    ]
  });
}


/* =========================================================
   UI
   ========================================================= */
function createNicknameModal() {
  const modal = new ModalBuilder()
    .setCustomId('eh_form')
    .setTitle('Egg Heist — Створити заявку');

  const nickname = new TextInputBuilder()
    .setCustomId('nickname')
    .setLabel('Нікнейм')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(32)
    .setPlaceholder('Ваш нікнейм у грі');

  const date = new TextInputBuilder()
    .setCustomId('date')
    .setLabel('Дата збору')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(5)
    .setPlaceholder('05.10');

  const time = new TextInputBuilder()
    .setCustomId('time')
    .setLabel('Час збору за Києвом')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(5)
    .setPlaceholder('16:00');

  const comment = new TextInputBuilder()
    .setCustomId('comment')
    .setLabel('Коментар')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(500)
    .setPlaceholder('Щось, що мають знати напарники?');

  modal.addComponents(
    new ActionRowBuilder().addComponents(nickname),
    new ActionRowBuilder().addComponents(date),
    new ActionRowBuilder().addComponents(time),
    new ActionRowBuilder().addComponents(comment)
  );

  return modal;
}

function createHoloBattleModal() {
  const modal = new ModalBuilder()
    .setCustomId('hb_form')
    .setTitle('Holo-Battle Interlink');

  const nickname = new TextInputBuilder()
    .setCustomId('nickname')
    .setLabel('Нікнейм')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(32)
    .setPlaceholder('Ваш нікнейм у грі');

  const date = new TextInputBuilder()
    .setCustomId('date')
    .setLabel('Дата збору')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(5)
    .setPlaceholder('05.10');

  const time = new TextInputBuilder()
    .setCustomId('time')
    .setLabel('Час збору за Києвом')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(5)
    .setPlaceholder('16:00');

  const comment = new TextInputBuilder()
    .setCustomId('comment')
    .setLabel('Коментар')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(500)
    .setPlaceholder('Щось, що мають знати напарники?');

  modal.addComponents(
    new ActionRowBuilder().addComponents(nickname),
    new ActionRowBuilder().addComponents(date),
    new ActionRowBuilder().addComponents(time),
    new ActionRowBuilder().addComponents(comment)
  );

  return modal;
}

function createProfileModal() {
  const modal = new ModalBuilder()
    .setCustomId('profile_form')
    .setTitle('Анкета гравця Aniimo');

  const nickname = new TextInputBuilder()
    .setCustomId('nickname')
    .setLabel('Нікнейм')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(32)
    .setPlaceholder('Ваш нікнейм у грі');

  const aniimoId = new TextInputBuilder()
    .setCustomId('aniimo_id')
    .setLabel('ID в Aniimo')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(32)
    .setPlaceholder('Ваш ID у грі');

  const level = new TextInputBuilder()
    .setCustomId('level')
    .setLabel('Рівень')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(20)
    .setPlaceholder('Наприклад: 50');

  const about = new TextInputBuilder()
    .setCustomId('about')
    .setLabel('Про себе')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(4000)
    .setPlaceholder('Розкажіть трохи про себе, свій стиль гри та кого шукаєте');

  modal.addComponents(
    new ActionRowBuilder().addComponents(nickname),
    new ActionRowBuilder().addComponents(aniimoId),
    new ActionRowBuilder().addComponents(level),
    new ActionRowBuilder().addComponents(about)
  );

  return modal;
}

function createServerSelect() {
  return new ActionRowBuilder().addComponents(

    new StringSelectMenuBuilder()
      .setCustomId('eh_servers')
      .setPlaceholder('Оберіть сервер(и)')
      .setMinValues(1)
      .setMaxValues(3)

      .addOptions(
        SERVERS.map(server => ({
          label: server.label,
          value: server.value
        }))
      )
  );
}

function createHoloBattleServerSelect() {
  return new ActionRowBuilder().addComponents(

    new StringSelectMenuBuilder()
      .setCustomId('hb_servers')
      .setPlaceholder('Оберіть сервер(и)')
      .setMinValues(1)
      .setMaxValues(3)

      .addOptions(
        SERVERS.map(server => ({
          label: server.label,
          value: server.value
        }))
      )
  );
}

function createProfileServerSelect() {
  return new ActionRowBuilder().addComponents(

    new StringSelectMenuBuilder()
      .setCustomId('profile_server')
      .setPlaceholder('Оберіть сервер(и)')
      .setMinValues(1)
      .setMaxValues(3)

      .addOptions(
        {
          label: 'Europe',
          value: 'Europe',
          emoji: '🇪🇺'
        },
        {
          label: 'Apac',
          value: 'Apac',
          emoji: '🌏'
        },
        {
          label: 'Americas',
          value: 'Americas',
          emoji: '🌎'
        }
      )
  );
}

function createDifficultySelect(selectedValues = []) {
  return new ActionRowBuilder().addComponents(

    new StringSelectMenuBuilder()
      .setCustomId('eh_difficulties')
      .setPlaceholder('Оберіть складність(і)')
      .setMinValues(1)
      .setMaxValues(4)

      .addOptions(
        DIFFICULTIES.map(difficulty => ({
          label: difficulty,
          value: difficulty,
          default:
            selectedValues.includes(difficulty)
        }))
      )
  );
}

function createPanelRow() {
  return new ActionRowBuilder().addComponents(

    new ButtonBuilder()
      .setCustomId('eh_start')
      .setLabel('Знайти команду Egg Heist')
      .setEmoji('🥚')
      .setStyle(ButtonStyle.Primary)
  );
}

function createProfilePanelRow() {
  return new ActionRowBuilder().addComponents(

    new ButtonBuilder()
      .setCustomId('profile_create')
      .setLabel('Створити анкету')
      .setEmoji('📝')
      .setStyle(ButtonStyle.Primary)
  );
}

function createHoloBattlePanelRow() {
  return new ActionRowBuilder().addComponents(

    new ButtonBuilder()
      .setCustomId('hb_start')
      .setLabel('Знайти команду Holo-Battle Interlink')
      .setEmoji('⚔️')
      .setStyle(ButtonStyle.Primary)
  );
}


/* =========================================================
   PUBLISH REQUEST
   ========================================================= */

async function publishRequest(data, interaction) {
  const id = createRequest(data);

  const channel = await client.channels.fetch(
    CONFIG.channelId
  );

  if (!channel || !channel.isTextBased()) {
    throw new Error(
      'EGG_HEIST_CHANNEL_ID is not a text channel.'
    );
  }

  const request = getRequest(id);
  const servers = data.servers;

  const message = await channel.send({

    content:
      roleMentions(servers),

    embeds: [
      buildRequestEmbed(request)
    ],

    components: [
      buildButtons(id, false)
    ],

    allowedMentions: {
      roles: [
        ...servers
          .map(server => CONFIG.roles[server])
          .filter(Boolean)
      ]
    }
  });

  db.prepare(`
    UPDATE requests
    SET message_id = ?
    WHERE id = ?
  `).run(
    message.id,
    id
  );

  await interaction.editReply({
    content:
      `✅ Вашу заявку Egg Heist опубліковано в <#${CONFIG.channelId}>.`
  });
}

/* =========================================================
   PUBLISH PROFILE
   ========================================================= */

async function publishProfile(
  data,
  interaction,
  photoFile = null
) {
  const channel =
    await client.channels.fetch(
      process.env.PROFILE_CHANNEL_ID
    );

  if (!channel || !channel.isTextBased()) {
    throw new Error(
      'PROFILE_CHANNEL_ID is not a text channel.'
    );
  }

  const embed =
    new EmbedBuilder()
      .setTitle('👤 Анкета гравця Aniimo')
      .setColor(0x5865F2)
      .setDescription(
        `**💬 Про себе**\n${data.about}`
      )
      .addFields(
        {
          name: '👤 Нікнейм',
          value: data.nickname,
          inline: true
        },
        {
          name: '🆔 ID в Aniimo',
          value: data.aniimoId,
          inline: true
        },
        {
          name: '⭐ Рівень',
          value: data.level,
          inline: true
        },
        {
          name: '🌐 Сервер',
          value: data.servers.join(', '),
          inline: false
        }
      )
      .setFooter({
        text: 'Aniimo Community'
      });

const sendOptions = {
  embeds: [embed],

  components: [

    new ActionRowBuilder().addComponents(

      new ButtonBuilder()
        .setLabel('Написати')
        .setEmoji('💬')
        .setStyle(
          ButtonStyle.Link
        )
        .setURL(
          `https://discord.com/users/${data.userId}`
        ),

      new ButtonBuilder()
        .setCustomId(
          `profile_delete:${data.userId}`
        )
        .setLabel('Видалити анкету')
        .setEmoji('🗑️')
        .setStyle(
          ButtonStyle.Danger
        )

    )

  ]
};

  if (photoFile) {
    embed.setImage(
      `attachment://${photoFile.name}`
    );

    sendOptions.files = [photoFile];
  }

  const message =
    await channel.send(sendOptions);

  let photoUrl = null;

  if (photoFile) {
    photoUrl =
      message.attachments.first()?.url || null;
  }

  db.prepare(`
    INSERT INTO profiles
      (
        user_id,
        nickname,
        aniimo_id,
        servers,
        level,
        about,
        message_id,
        photo_url,
        created_at
      )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.userId,
    data.nickname,
    data.aniimoId,
    JSON.stringify(data.servers),
    data.level,
    data.about,
    message.id,
    photoUrl,
    Date.now()
  );

  pendingProfiles.delete(
    data.userId
  );

  waitingForProfilePhoto.delete(
    data.userId
  );

  return message;
}

/* =========================================================

   SLASH COMMAND REGISTRATION

   ========================================================= */

const commands = [

  new SlashCommandBuilder()

    .setName('eggheist')

    .setDescription(

      'Створити заявку на команду Egg Heist.'

    ),

  new SlashCommandBuilder()

    .setName('eggheist-panel')

    .setDescription(

      'Опублікувати кнопку створення заявки Egg Heist у цьому каналі.'

    )

    .setDefaultMemberPermissions(

      PermissionFlagsBits.ManageGuild.toString()

    ),

  new SlashCommandBuilder()

    .setName('holobattle')

    .setDescription(

      'Створити заявку на команду Holo-Battle Interlink.'

    ),

  new SlashCommandBuilder()

    .setName('holobattle-panel')

    .setDescription(

      'Опублікувати кнопку створення заявки Holo-Battle Interlink у цьому каналі.'

    )

    .setDefaultMemberPermissions(

      PermissionFlagsBits.ManageGuild.toString()

    ),

  new SlashCommandBuilder()

    .setName('profile-panel')

    .setDescription(

      'Опублікувати панель створення анкети гравця.'

    )

    .setDefaultMemberPermissions(

      PermissionFlagsBits.ManageGuild.toString()

    )

];

const rest = new REST({
  version: '10'
}).setToken(
  process.env.DISCORD_TOKEN
);

await rest.put(
  Routes.applicationGuildCommands(
    process.env.CLIENT_ID,
    process.env.GUILD_ID
  ),
  {
    body: commands.map(
      command => command.toJSON()
    )
  }
);


/* =========================================================
   BOT READY
   ========================================================= */

client.once('ready', () => {
  console.log(
    `Logged in as ${client.user.tag}`
  );
});


/* =========================================================
   INTERACTIONS
   ========================================================= */

client.on(
  'interactionCreate',
  async interaction => {

    try {

      /* ---------------------------------------------
         /eggheist
         --------------------------------------------- */

      if (
        interaction.isChatInputCommand() &&
        interaction.commandName === 'eggheist'
      ) {

        await interaction.showModal(
          createNicknameModal()
        );

        return;
      }

      /* ---------------------------------------------
         /holobattle
         --------------------------------------------- */

      if (
        interaction.isChatInputCommand() &&
        interaction.commandName === 'holobattle'
      ) {

        await interaction.showModal(
          createHoloBattleModal()
        );

        return;
      }      

      /* ---------------------------------------------
         /eggheist-panel
         --------------------------------------------- */

      if (
        interaction.isChatInputCommand() &&
        interaction.commandName === 'eggheist-panel'
      ) {

        const channel = await client.channels.fetch(
          CONFIG.channelId
        );

        if (!channel || !channel.isTextBased()) {
          throw new Error(
            'EGG_HEIST_CHANNEL_ID is not a valid text channel.'
          );
        }

        await channel.send({

          embeds: [
            new EmbedBuilder()
              .setTitle(
                '🥚 Egg Heist — Пошук команди'
              )
              .setDescription(
                'Натисніть кнопку нижче та заповніть нікнейм, сервер, складність і коментар.'
              )
          ],

          components: [
            createPanelRow()
          ]
        });

        await interaction.reply({
          content:
            `✅ Egg Heist panel posted in <#${CONFIG.channelId}>`,
          flags: MessageFlags.Ephemeral
        });

        return;
      }

      /* ---------------------------------------------
         /holobattle-panel
         --------------------------------------------- */

      if (
        interaction.isChatInputCommand() &&
        interaction.commandName === 'holobattle-panel'
      ) {

        const channel = await client.channels.fetch(
          process.env.HOLO_BATTLE_CHANNEL_ID
        );

        if (!channel || !channel.isTextBased()) {
          throw new Error(
            'EGG_HEIST_CHANNEL_ID is not a valid text channel.'
          );
        }

        await channel.send({

          embeds: [
            new EmbedBuilder()
              .setTitle(
                '⚔️ Holo-Battle Interlink — Знайти команду'
              )
              .setDescription(
                'Натисніть кнопку нижче та створіть заявку на збір.'
              )
          ],

          components: [
            createHoloBattlePanelRow()
          ]
        });

        await interaction.reply({
          content:
            `✅ Панель Holo-Battle Interlink опубліковано в <#${CONFIG.channelId}>.`,
          flags: MessageFlags.Ephemeral
        });

        return;
      }

            /* ---------------------------------------------
         /profile-panel
         --------------------------------------------- */

      if (
        interaction.isChatInputCommand() &&
        interaction.commandName === 'profile-panel'
      ) {

        const channel = await client.channels.fetch(
          process.env.PROFILE_CHANNEL_ID
        );

        if (!channel || !channel.isTextBased()) {
          throw new Error(
            'PROFILE_CHANNEL_ID is not a valid text channel.'
          );
        }

        await channel.send({

          embeds: [
            new EmbedBuilder()
              .setTitle(
                '📝 Анкети гравців Aniimo'
              )
              .setDescription(
                'Хочете знайти напарників для спільної гри? Заповніть коротку анкету нижче.'
              )
          ],

          components: [
            createProfilePanelRow()
          ]
        });

        await interaction.reply({
          content:
            `✅ Панель анкет опубліковано в <#${process.env.PROFILE_CHANNEL_ID}>.`,
          flags: MessageFlags.Ephemeral
        });

        return;
      }

      /* ---------------------------------------------
         PANEL BUTTON
         --------------------------------------------- */

      if (
        interaction.isButton() &&
        interaction.customId === 'eh_start'
      ) {

        await interaction.showModal(
          createNicknameModal()
        );

        return;
      }

            /* ---------------------------------------------
         PROFILE PANEL BUTTON
         --------------------------------------------- */

      if (
        interaction.isButton() &&
        interaction.customId === 'profile_create'
      ) {

        await interaction.showModal(
          createProfileModal()
        );

        return;
      }

            /* ---------------------------------------------
         PROFILE ADD PHOTO
         --------------------------------------------- */

      if (
        interaction.isButton() &&
        interaction.customId === 'profile_add_photo'
      ) {

        const data =
          pendingProfiles.get(
            interaction.user.id
          );

        if (!data) {

          await interaction.reply({
            content:
              '❌ Дані анкети більше недоступні. Створіть анкету ще раз.',

            flags:
              MessageFlags.Ephemeral
          });

          return;
        }

        waitingForProfilePhoto.set(
          interaction.user.id,
          true
        );

        await interaction.update({

          content:
            '📷 **Надішліть одне фото в цей канал.**\n\n' +
            'Анкета поки що **не опублікована**.\n' +
            'Після надсилання фото бот використає його для анкети.',

          components: [

            new ActionRowBuilder().addComponents(

              new ButtonBuilder()
                .setCustomId(
                  'profile_cancel_photo'
                )
                .setLabel('Скасувати')
                .setEmoji('❌')
                .setStyle(
                  ButtonStyle.Secondary
                )

            )

          ]

        });

        return;
      }

      /* ---------------------------------------------
         PROFILE CANCEL PHOTO
         --------------------------------------------- */

      if (
        interaction.isButton() &&
        interaction.customId === 'profile_cancel_photo'
      ) {
        const data =
          pendingProfiles.get(
            interaction.user.id
          );

        if (!data) {
          await interaction.reply({
            content:
              '❌ Дані анкети більше недоступні. Створіть анкету ще раз.',
            flags:
              MessageFlags.Ephemeral
          });

          return;
        }

        waitingForProfilePhoto.delete(
          interaction.user.id
        );

        await interaction.update({
          content:
            '### 2/2 — Фото анкети\n\n' +
            '📷 **Хочете додати фото до анкети?**\n\n' +
            'Фото можна додати зараз або опублікувати анкету без нього.',
          components: [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId('profile_add_photo')
                .setLabel('Додати фото')
                .setEmoji('📷')
                .setStyle(ButtonStyle.Primary),

              new ButtonBuilder()
                .setCustomId('profile_publish_no_photo')
                .setLabel('Опублікувати без фото')
                .setEmoji('➡️')
                .setStyle(ButtonStyle.Success)
            )
          ]
        });

        return;
      }
      
      /* ---------------------------------------------
         HOLO-BATTLE PANEL BUTTON
         --------------------------------------------- */

      if (
        interaction.isButton() &&
        interaction.customId === 'hb_start'
      ) {

        await interaction.showModal(
          createHoloBattleModal()
        );

        return;
      }      

      /* ---------------------------------------------
         MODAL SUBMIT
         --------------------------------------------- */

      if (
        interaction.isModalSubmit() &&
        interaction.customId === 'eh_form'
      ) {

                const date =
          interaction.fields
            .getTextInputValue('date')
            .trim();

        const time =
          interaction.fields
            .getTextInputValue('time')
            .trim();

        const scheduledAt =
          parseKyivDateTime(
            date,
            time
          );

        if (!scheduledAt) {
          await interaction.reply({
            content:
              '❌ Неправильна дата або час.\n\nВикористовуйте формат:\n`05.10` та `16:00`.',
            flags:
              MessageFlags.Ephemeral
          });

          return;
        }

        if (
          scheduledAt <= Date.now()
        ) {
          await interaction.reply({
            content:
              '❌ Запланований час уже минув. Вкажіть майбутній час.',
            flags:
              MessageFlags.Ephemeral
          });

          return;
        }
        
        const key =
          `${interaction.user.id}:${Date.now()}`;

        pending.set(
          key,
          {
            creatorId:
              interaction.user.id,

            nickname:
              interaction.fields
                .getTextInputValue('nickname')
                .trim(),

            comment:
              interaction.fields
                .getTextInputValue('comment')
                .trim(),

            scheduledAt
          }
        );

        setTimeout(
          () => pending.delete(key),
          15 * 60 * 1000
        );

        await interaction.reply({

          content:
            '### 1/2 — Оберіть сервер(и):',

          components: [
            createServerSelect(),

            new ActionRowBuilder().addComponents(

              new ButtonBuilder()
                .setCustomId(
                  `eh_next:${key}`
                )
                .setLabel('Далі')
                .setStyle(
                  ButtonStyle.Primary
                )
            )
          ],

          flags: MessageFlags.Ephemeral
        });

        return;
      }

      /* ---------------------------------------------
         PROFILE MODAL SUBMIT
         --------------------------------------------- */

      if (
        interaction.isModalSubmit() &&
        interaction.customId === 'profile_form'
      ) {

        const nickname =
          interaction.fields
            .getTextInputValue('nickname')
            .trim();

        const aniimoId =
          interaction.fields
            .getTextInputValue('aniimo_id')
            .trim();

        const level =
          interaction.fields
            .getTextInputValue('level')
            .trim();

        const about =
          interaction.fields
            .getTextInputValue('about')
            .trim();

        pendingProfiles.set(
          interaction.user.id,
          {
            userId:
              interaction.user.id,

            nickname,

            aniimoId,

            level,

            about,

            servers: []
          }
        );

        await interaction.reply({

          content:
            '### 1/2 — Оберіть сервер(и)\n\nМожна обрати один або декілька серверів.',

          components: [

            createProfileServerSelect(),

            new ActionRowBuilder().addComponents(

              new ButtonBuilder()
                .setCustomId('profile_next')
                .setLabel('Далі')
                .setStyle(
                  ButtonStyle.Primary
                )

            )

          ],

          flags:
            MessageFlags.Ephemeral
        });

        return;
      }

      /* ---------------------------------------------
         PROFILE SERVER SELECT
         --------------------------------------------- */

      if (
        interaction.isStringSelectMenu() &&
        interaction.customId === 'profile_server'
      ) {

        const data =
          pendingProfiles.get(
            interaction.user.id
          );

        if (!data) {

          await interaction.reply({
            content:
              '❌ Дані анкети більше недоступні. Створіть анкету ще раз.',

            flags:
              MessageFlags.Ephemeral
          });

          return;
        }

        data.servers =
          interaction.values;

        await interaction.update({

          content:
            '### 1/2 — Оберіть сервер(и)\n\n' +
            'Можна обрати один або декілька серверів.\n\n' +
            `**Обрано:** ${data.servers.join(', ')}`,

          components: [

            createProfileServerSelect(),

            new ActionRowBuilder().addComponents(

              new ButtonBuilder()
                .setCustomId('profile_next')
                .setLabel('Далі')
                .setStyle(
                  ButtonStyle.Primary
                )

            )

          ]

        });

        return;
      }


      /* ---------------------------------------------
         PROFILE NEXT
         --------------------------------------------- */

      if (
        interaction.isButton() &&
        interaction.customId === 'profile_next'
      ) {

        const data =
          pendingProfiles.get(
            interaction.user.id
          );

        if (!data) {

          await interaction.reply({
            content:
              '❌ Дані анкети більше недоступні. Створіть анкету ще раз.',

            flags:
              MessageFlags.Ephemeral
          });

          return;
        }

        if (
          !data.servers ||
          data.servers.length === 0
        ) {

          await interaction.reply({
            content:
              '❌ Будь ласка, оберіть хоча б один сервер.',

            flags:
              MessageFlags.Ephemeral
          });

          return;
        }

        await interaction.update({

          content:
            '### 2/2 — Фото анкети\n\n' +
            '📷 **Хочете додати фото до анкети?**\n\n' +
            'Фото можна додати зараз або опублікувати анкету без нього.',

          components: [

            new ActionRowBuilder().addComponents(

              new ButtonBuilder()
                .setCustomId('profile_add_photo')
                .setLabel('Додати фото')
                .setEmoji('📷')
                .setStyle(
                  ButtonStyle.Primary
                ),

              new ButtonBuilder()
                .setCustomId('profile_publish_no_photo')
                .setLabel('Опублікувати без фото')
                .setEmoji('➡️')
                .setStyle(
                  ButtonStyle.Success
                )

            )

          ]

        });

        return;
      }

      /* ---------------------------------------------
         PROFILE DELETE
         --------------------------------------------- */

      if (
        interaction.isButton() &&
        interaction.customId.startsWith(
          'profile_delete:'
        )
      ) {

        const userId =
          interaction.customId.split(':')[1];

        if (
          interaction.user.id !== userId
        ) {

          await interaction.reply({
            content:
              '❌ Видалити анкету може тільки її автор.',

            flags:
              MessageFlags.Ephemeral
          });

          return;
        }

        const profile =
          db.prepare(`
            SELECT *
            FROM profiles
            WHERE user_id = ?
            ORDER BY id DESC
            LIMIT 1
          `).get(userId);

        if (!profile) {

          await interaction.reply({
            content:
              '❌ Анкету не знайдено.',

            flags:
              MessageFlags.Ephemeral
          });

          return;
        }

        try {

          await interaction.message.delete();

          db.prepare(`
            DELETE FROM profiles
            WHERE id = ?
          `).run(profile.id);

          await interaction.reply({
            content:
              '🗑️ Вашу анкету видалено.',

            flags:
              MessageFlags.Ephemeral
          });

        } catch (error) {

          console.error(
            'Failed to delete profile:',
            error
          );

          await interaction.reply({
            content:
              '❌ Не вдалося видалити анкету.',

            flags:
              MessageFlags.Ephemeral
          });
        }

        return;
      }
            /* ---------------------------------------------
         PROFILE PUBLISH WITHOUT PHOTO
         --------------------------------------------- */

      if (
        interaction.isButton() &&
        interaction.customId === 'profile_publish_no_photo'
      ) {

        const data =
          pendingProfiles.get(
            interaction.user.id
          );

        if (!data) {

          await interaction.reply({
            content:
              '❌ Дані анкети більше недоступні. Створіть анкету ще раз.',

            flags:
              MessageFlags.Ephemeral
          });

          return;
        }

        if (
          !data.servers ||
          data.servers.length === 0
        ) {

          await interaction.reply({
            content:
              '❌ Будь ласка, оберіть хоча б один сервер.',

            flags:
              MessageFlags.Ephemeral
          });

          return;
        }

        await publishProfile(
          data,
          interaction
        );

        return;
      }

      /* ---------------------------------------------
         HOLO-BATTLE MODAL SUBMIT
         --------------------------------------------- */

      if (
        interaction.isModalSubmit() &&
        interaction.customId === 'hb_form'
      ) {

        const nickname =
          interaction.fields
            .getTextInputValue('nickname')
            .trim();

        const date =
          interaction.fields
            .getTextInputValue('date')
            .trim();

        const time =
          interaction.fields
            .getTextInputValue('time')
            .trim();

        const comment =
          interaction.fields
            .getTextInputValue('comment')
            .trim();

        const scheduledAt =
          parseKyivDateTime(
            date,
            time
          );

        if (!scheduledAt) {

          await interaction.reply({
            content:
              '❌ Неправильна дата або час.\n\nВикористовуйте формат:\n`05.10` та `16:00`.',
            flags:
              MessageFlags.Ephemeral
          });

          return;
        }

        if (
          scheduledAt <= Date.now()
        ) {

          await interaction.reply({
            content:
              '❌ Запланований час уже минув. Вкажіть майбутній час.',
            flags:
              MessageFlags.Ephemeral
          });

          return;
        }

        const holoWindow =
          getHoloBattleWindow(
            scheduledAt
          );

        if (!holoWindow.valid) {

          await interaction.reply({
            content:
              `❌ Цей час не підходить для Holo-Battle Interlink.\n\n` +
              `Збір доступний з четверга 04:00 UTC+8 до понеділка 03:59 UTC+8.\n\n` +
              `📅 Найближче доступне вікно за Києвом:\n` +
              `**${formatKyivDateTime(holoWindow.start)} — ${formatKyivDateTime(holoWindow.end)}**\n\n` +
              `Будь ласка, вкажіть дату та час у цьому проміжку.`,
            flags:
              MessageFlags.Ephemeral
          });

          return;
        }

        pending.set(
          interaction.user.id,
          {
            mode: 'holobattle',
            creatorId:
              interaction.user.id,
            nickname,
            scheduledAt,
            comment,
            servers: []
          }
        );

        await interaction.reply({
          content:
            '### 1/2 — Оберіть сервер(и):',

          components: [

            createHoloBattleServerSelect(),

            new ActionRowBuilder().addComponents(

              new ButtonBuilder()
                .setCustomId(
                  `hb_next:${interaction.user.id}`
                )
                .setLabel('Далі')
                .setStyle(
                  ButtonStyle.Primary
                )

            )

          ],

          flags:
            MessageFlags.Ephemeral
        });

        return;
      }

      /* ---------------------------------------------
         HOLO-BATTLE SERVER SELECT
         --------------------------------------------- */

      if (
        interaction.isStringSelectMenu() &&
        interaction.customId === 'hb_servers'
      ) {

        const data =
          pending.get(
            interaction.user.id
          );

        if (
          !data ||
          data.mode !== 'holobattle'
        ) {

          await interaction.reply({
            content:
              '❌ Дані заявки більше недоступні. Створіть заявку ще раз.',
            flags:
              MessageFlags.Ephemeral
          });

          return;
        }

        data.servers =
          interaction.values;

        await interaction.deferUpdate();

        return;
      }

      /* ---------------------------------------------
         HOLO-BATTLE CONTINUE
         --------------------------------------------- */

      if (
        interaction.isButton() &&
        interaction.customId.startsWith(
          'hb_next:'
        )
      ) {

        const userId =
          interaction.customId.slice(
            'hb_next:'.length
          );

        const data =
          pending.get(userId);

        if (
          !data ||
          data.mode !== 'holobattle' ||
          data.creatorId !== interaction.user.id
        ) {

          await interaction.reply({
            content:
              '❌ Дані заявки більше недоступні. Створіть заявку ще раз.',
            flags:
              MessageFlags.Ephemeral
          });

          return;
        }

        if (
          !data.servers ||
          data.servers.length === 0
        ) {

          await interaction.reply({
            content:
              '❌ Будь ласка, оберіть хоча б один сервер.',
            flags:
              MessageFlags.Ephemeral
          });

          return;
        }

        await interaction.update({
          content:
            '### Сервери обрано.\n\n' +
            'Натисніть кнопку нижче, щоб створити заявку.',
          components: [
            new ActionRowBuilder().addComponents(

              new ButtonBuilder()
                .setCustomId(
                  'hb_create'
                )
                .setLabel(
                  'Створити заявку'
                )
                .setEmoji('⚔️')
                .setStyle(
                  ButtonStyle.Success
                )

            )
          ]
        });

        return;
      }      

            /* ---------------------------------------------
         HOLO-BATTLE CREATE REQUEST
         --------------------------------------------- */

      if (
        interaction.isButton() &&
        interaction.customId === 'hb_create'
      ) {

        const data =
          pending.get(
            interaction.user.id
          );

        if (
          !data ||
          data.mode !== 'holobattle'
        ) {

          await interaction.reply({
            content:
              '❌ Дані заявки більше недоступні. Створіть заявку ще раз.',
            flags:
              MessageFlags.Ephemeral
          });

          return;
        }

                if (
          !data.servers ||
          data.servers.length === 0
        ) {

          await interaction.reply({
            content:
              '❌ Будь ласка, оберіть хоча б один сервер.',
            flags:
              MessageFlags.Ephemeral
          });

          return;
        }

        const id =
          createHoloBattleRequest(
            data
          );

        const request =
          getRequest(id);

        const channel =
          await client.channels.fetch(
            process.env.HOLO_BATTLE_CHANNEL_ID
          );

        if (
          !channel ||
          !channel.isTextBased()
        ) {
          throw new Error(
            'HOLO_BATTLE_CHANNEL_ID is not a text channel.'
          );
        }

        const message =
          await channel.send({

            content:
              roleMentions(
                data.servers
              ),

            embeds: [
              buildHoloBattleEmbed(
                request
              )
            ],

            components: [
              buildHoloBattleButtons(
                id,
                false
              )
            ],

            allowedMentions: {
              roles: [
                ...data.servers
                  .map(
                    server =>
                      CONFIG.roles[server]
                  )
                  .filter(Boolean)
              ]
            }
          });

        db.prepare(`
          UPDATE requests
          SET message_id = ?
          WHERE id = ?
        `).run(
          message.id,
          id
        );

        pending.delete(
          interaction.user.id
        );

        await interaction.update({
          content:
            `✅ Вашу заявку Holo-Battle Interlink опубліковано в <#${process.env.HOLO_BATTLE_CHANNEL_ID}>.`,
          components: []
        });

        return;
      }

      /* ---------------------------------------------
         SERVER SELECT
         --------------------------------------------- */

      if (
        interaction.isStringSelectMenu() &&
        interaction.customId === 'eh_servers'
      ) {

        const key =
          [...pending.keys()]
            .reverse()
            .find(
              key =>
                pending.get(key)?.creatorId ===
                interaction.user.id
            );

        if (!key) {

          await interaction.reply({
            content:
              'Ця анкета застаріла. Почніть заново за допомогою /eggheist.',

            flags:
              MessageFlags.Ephemeral
          });

          return;
        }

        pending.get(key).servers =
          interaction.values;

        await interaction.deferUpdate();

        return;
      }


      /* ---------------------------------------------
         CONTINUE TO DIFFICULTY
         --------------------------------------------- */

      if (
        interaction.isButton() &&
        interaction.customId.startsWith(
          'eh_next:'
        )
      ) {

        const key =
          interaction.customId.slice(
            'eh_next:'.length
          );

        const data =
          pending.get(key);

        if (
          !data ||
          data.creatorId !== interaction.user.id
        ) {

          await interaction.reply({
            content:
              'This form expired. Start again with /eggheist.',

            flags:
              MessageFlags.Ephemeral
          });

          return;
        }

        if (
          !data.servers ||
          data.servers.length === 0
        ) {

          await interaction.reply({
            content:
              'Please select at least one server first.',

            flags:
              MessageFlags.Ephemeral
          });

          return;
        }

        await interaction.update({

          content:
            '### 2/2 — Оберіть складність(і):',

          components: [

            createDifficultySelect(),

            new ActionRowBuilder().addComponents(

              new ButtonBuilder()
                .setCustomId(
                  `eh_publish:${key}`
                )
                .setLabel('Створити заявку')
                .setStyle(
                  ButtonStyle.Success
                )
            )
          ]
        });

        return;
      }


      /* ---------------------------------------------
         DIFFICULTY SELECT
         --------------------------------------------- */

      if (
        interaction.isStringSelectMenu() &&
        interaction.customId === 'eh_difficulties'
      ) {

        const key =
          [...pending.keys()]
            .reverse()
            .find(
              key =>
                pending.get(key)?.creatorId ===
                interaction.user.id
            );

        if (!key) {

          await interaction.reply({
            content:
              'Ця анкета застаріла. Почніть заново за допомогою /eggheist.',

            flags:
              MessageFlags.Ephemeral
          });

          return;
        }

        pending.get(key).difficulties =
          interaction.values;

        await interaction.deferUpdate();

        await interaction.editReply({

          content:
            '### 2/2 — Оберіть складність(і):',

          components: [

            createDifficultySelect(
              interaction.values
            ),

            new ActionRowBuilder().addComponents(

              new ButtonBuilder()
                .setCustomId(
                  `eh_publish:${key}`
                )
                .setLabel('Створити заявку')
                .setStyle(
                  ButtonStyle.Success
                )

            )
          ]

        });

        return;
      }


      /* ---------------------------------------------
         CREATE REQUEST
         --------------------------------------------- */

      if (
        interaction.isButton() &&
        interaction.customId.startsWith(
          'eh_publish:'
        )
      ) {

        const key =
          interaction.customId.slice(
            'eh_publish:'.length
          );

        const data =
          pending.get(key);

        if (
          !data ||
          data.creatorId !== interaction.user.id
        ) {

          await interaction.reply({
            content:
              'This form expired. Start again with /eggheist.',

            flags:
              MessageFlags.Ephemeral
          });

          return;
        }

        if (
          !data.servers ||
          data.servers.length === 0
        ) {

          await interaction.reply({
            content:
              'Будь ласка, оберіть хоча б один сервер.',

            flags:
              MessageFlags.Ephemeral
          });

          return;
        }

        if (
          !data.difficulties ||
          data.difficulties.length === 0
        ) {

          await interaction.reply({
            content:
              'Будь ласка, оберіть хоча б одну складність.',

            flags:
              MessageFlags.Ephemeral
          });

          return;
        }

        await interaction.deferReply({
          flags:
            MessageFlags.Ephemeral
        });

        pending.delete(key);

        await publishRequest(
          data,
          interaction
        );

        return;
      }

      /* ---------------------------------------------
         DELETE REQUEST
         --------------------------------------------- */

      if (
        interaction.isButton() &&
        interaction.customId.startsWith(
          'delete_request:'
        )
      ) {

        const id =
          Number(
            interaction.customId.split(':')[1]
          );

        const request =
          getRequest(id);

        if (!request) {

          await interaction.reply({
            content:
              '❌ Ця заявка більше не існує.',
            flags:
              MessageFlags.Ephemeral
          });

          return;
        }

        if (
          request.creator_id !==
          interaction.user.id
        ) {

          await interaction.reply({
            content:
              '❌ Видалити заявку може тільки її автор.',
            flags:
              MessageFlags.Ephemeral
          });

          return;
        }

        await interaction.reply({
          content:
            '⚠️ **Ви точно хочете видалити цю заявку?**\n\n' +
            'Це видалить пост і всіх учасників заявки.',

          components: [
            new ActionRowBuilder().addComponents(

              new ButtonBuilder()
                .setCustomId(
                  `delete_confirm:${id}`
                )
                .setLabel(
                  'Так, видалити'
                )
                .setEmoji('🗑️')
                .setStyle(
                  ButtonStyle.Danger
                ),

              new ButtonBuilder()
                .setCustomId(
                  `delete_cancel:${id}`
                )
                .setLabel(
                  'Скасувати'
                )
                .setEmoji('↩️')
                .setStyle(
                  ButtonStyle.Secondary
                )

            )
          ],

          flags:
            MessageFlags.Ephemeral
        });

        return;
      }

      /* ---------------------------------------------
         CONFIRM DELETE REQUEST
         --------------------------------------------- */

      if (
        interaction.isButton() &&
        interaction.customId.startsWith(
          'delete_confirm:'
        )
      ) {

        const id =
          Number(
            interaction.customId.split(':')[1]
          );

        const request =
          getRequest(id);

        if (!request) {

          await interaction.update({
            content:
              '❌ Ця заявка більше не існує.',
            components: []
          });

          return;
        }

        if (
          request.creator_id !==
          interaction.user.id
        ) {

          await interaction.update({
            content:
              '❌ Видалити заявку може тільки її автор.',
            components: []
          });

          return;
        }

        try {

          const channel =
            await client.channels.fetch(
              request.channel_id
            );

          if (
            channel &&
            channel.isTextBased() &&
            request.message_id
          ) {

            const message =
              await channel.messages.fetch(
                request.message_id
              );

            await message.delete();
          }

          db.prepare(`
            DELETE FROM participants
            WHERE request_id = ?
          `).run(id);

          db.prepare(`
            DELETE FROM requests
            WHERE id = ?
          `).run(id);

          await interaction.update({
            content:
              '🗑️ Заявку успішно видалено.',
            components: []
          });

        } catch (error) {

          console.error(
            'Failed to delete request:',
            error
          );

          await interaction.update({
            content:
              '❌ Не вдалося видалити заявку. Перевірте консоль бота.',
            components: []
          });
        }

        return;
      }

      /* ---------------------------------------------
         CANCEL DELETE REQUEST
         --------------------------------------------- */

      if (
        interaction.isButton() &&
        interaction.customId.startsWith(
          'delete_cancel:'
        )
      ) {

        await interaction.update({
          content:
            '↩️ Видалення скасовано.',
          components: []
        });

        return;
      }

      /* ---------------------------------------------
         JOIN / LEAVE
         --------------------------------------------- */

      if (
        interaction.isButton() &&
        (
          interaction.customId.startsWith(
            'eh_join:'
          ) ||
          interaction.customId.startsWith(
            'eh_leave:'
          )
        )
      ) {

        const [
          action,
          idText
        ] =
          interaction.customId.split(':');

        const id =
          Number(idText);


        /* JOIN */

        if (action === 'eh_join') {

          const request =
            getRequest(id);

          if (!request) {
            await interaction.reply({
              content:
                'Ця заявка більше не існує.',
              flags:
                MessageFlags.Ephemeral
            });

            return;
          }

          if (
            Date.now() >=
            request.scheduled_at +
            60 * 60 * 1000
          ) {
            await interaction.reply({
              content:
                '🔴 Збір уже завершено. Приєднання більше недоступне.',
              flags:
                MessageFlags.Ephemeral
            });

            await refreshRequestMessage(id);

            return;
          }

          const result =
            addParticipant(
              id,
              interaction.user.id
            );

          if (!result.ok) {

            const messages = {
              not_found:
                'Ця заявка більше не існує.',

              already:
                'Ви вже в цій групі.',

              full:
                'Основна група та резервна черга вже заповнені.'
            };

            await interaction.reply({

              content:
                messages[result.reason] ||
                'Не вдалося приєднатися до цієї групи.',

              flags:
                MessageFlags.Ephemeral
            });

            return;
          }

          const updatedRequest =
            getRequest(id);

          const updatedParticipants =
            getParticipants(id);

          const isFull =
            updatedParticipants.length >= 5;

          const isFinished =
            Date.now() >=
            updatedRequest.scheduled_at +
            60 * 60 * 1000;

          await interaction.update({
            embeds: [
              buildRequestEmbed(updatedRequest)
            ],
            components: [
              buildButtons(
                id,
                isFull,
                isFinished
              )
            ]
          });

          return;
        }


        /* LEAVE */

        if (action === 'eh_leave') {

          const removed =
            removeParticipant(
              id,
              interaction.user.id
            );

          if (!removed) {

            await interaction.reply({

              content:
                'Ви не перебуваєте в цій групі.',

              flags:
                MessageFlags.Ephemeral
            });

            return;
          }

          const updatedRequest =
            getRequest(id);

          const updatedParticipants =
            getParticipants(id);

          const isFull =
            updatedParticipants.length >= 5;

          const isFinished =
            Date.now() >=
            updatedRequest.scheduled_at +
            60 * 60 * 1000;

          await interaction.update({
            embeds: [
              buildRequestEmbed(updatedRequest)
            ],
            components: [
              buildButtons(
                id,
                isFull,
                isFinished
              )
            ]
          });

          return;
        }
      }

      /* ---------------------------------------------
         HOLO-BATTLE JOIN / LEAVE
         --------------------------------------------- */

      if (
        interaction.isButton() &&
        (
          interaction.customId.startsWith('hb_join:') ||
          interaction.customId.startsWith('hb_leave:')
        )
      ) {

        const [
          action,
          idText
        ] =
          interaction.customId.split(':');

        const id =
          Number(idText);

        const request =
          getRequest(id);

        if (!request) {

          await interaction.reply({
            content:
              '❌ Ця заявка більше не існує.',
            flags:
              MessageFlags.Ephemeral
          });

          return;
        }

        if (
          Date.now() >=
          request.scheduled_at +
          60 * 60 * 1000
        ) {

          await interaction.reply({
            content:
              '🔴 Збір уже завершено. Приєднання більше недоступне.',
            flags:
              MessageFlags.Ephemeral
          });

          await refreshHoloBattleMessage(id);

          return;
        }

        const participants =
          getParticipants(id);

        /* JOIN */

        if (action === 'hb_join') {

          if (
            participants.includes(
              interaction.user.id
            )
          ) {

            await interaction.reply({
              content:
                '❌ Ви вже є в цій групі.',
              flags:
                MessageFlags.Ephemeral
            });

            return;
          }

          if (
            participants.length >= 2
          ) {

            await interaction.reply({
              content:
                '❌ Основна група та резервна черга вже заповнені.',
              flags:
                MessageFlags.Ephemeral
            });

            return;
          }

          db.prepare(`
            INSERT INTO participants
              (
                request_id,
                user_id,
                joined_at
              )
            VALUES (?, ?, ?)
          `).run(
            id,
            interaction.user.id,
            Date.now()
          );

          const updatedRequest =
            getRequest(id);

          const updatedParticipants =
            getParticipants(id);

          const isFull =
            updatedParticipants.length >= 6;

          const isFinished =
            Date.now() >=
            updatedRequest.scheduled_at +
            60 * 60 * 1000;

          await interaction.update({
            embeds: [
              buildHoloBattleEmbed(
                updatedRequest
              )
            ],
            components: [
              buildHoloBattleButtons(
                id,
                isFull,
                isFinished
              )
            ]
          });

          return;
        }

        /* LEAVE */

        if (action === 'hb_leave') {

          const removed =
            removeParticipant(
              id,
              interaction.user.id
            );

          if (!removed) {

            await interaction.reply({
              content:
                '❌ Ви не перебуваєте в цій групі.',
              flags:
                MessageFlags.Ephemeral
            });

            return;
          }

          const updatedRequest =
            getRequest(id);

          const updatedParticipants =
            getParticipants(id);

          const isFull =
            updatedParticipants.length >= 6;

          const isFinished =
            Date.now() >=
            updatedRequest.scheduled_at +
            60 * 60 * 1000;

          await interaction.update({
            embeds: [
              buildHoloBattleEmbed(
                updatedRequest
              )
            ],
            components: [
              buildHoloBattleButtons(
                id,
                isFull,
                isFinished
              )
            ]
          });

          return;
        }
      }
      

    } catch (error) {

      console.error(error);

      if (
        interaction.isRepliable() &&
        !interaction.replied &&
        !interaction.deferred
      ) {

        await interaction.reply({

          content:
            'Щось пішло не так. Перевірте логи бота.',

          flags:
            MessageFlags.Ephemeral

        }).catch(() => {});
      }
    }
  }
);


setInterval(
  async () => {
    try {
      const requests =
        db
          .prepare(`
            SELECT *
            FROM requests
            WHERE message_id IS NOT NULL
          `)
          .all();

      const now = Date.now();

      for (const request of requests) {

        const finishedAt =
          request.scheduled_at +
          60 * 60 * 1000;

        const deleteAt =
          finishedAt +
          24 * 60 * 60 * 1000;

        /*
         * Видаляємо завершені заявки
         * через 24 години після завершення.
         */

        if (now >= deleteAt) {

          try {
            const channel =
              await client.channels.fetch(
                request.channel_id
              );

            if (
              channel &&
              channel.isTextBased()
            ) {
              try {
                const message =
                  await channel.messages.fetch(
                    request.message_id
                  );

                await message.delete();

              } catch (error) {

                /*
                 * Якщо повідомлення вже видалене —
                 * це не проблема.
                 */

                if (
                  error?.code !== 10008
                ) {
                  throw error;
                }
              }
            }

            db.prepare(`
              DELETE FROM participants
              WHERE request_id = ?
            `).run(
              request.id
            );

            db.prepare(`
              DELETE FROM requests
              WHERE id = ?
            `).run(
              request.id
            );

            console.log(
              `Deleted old Egg Heist request #${request.id}`
            );

          } catch (error) {

            console.error(
              `Failed to delete old request #${request.id}:`,
              error
            );
          }

          continue;
        }

        /*
         * Якщо збір уже завершився —
         * оновлюємо повідомлення,
         * щоб кнопка Join стала
         * "Збір завершено".
         */

        if (now >= finishedAt) {

          try {

            if (request.mode === 'holobattle') {

              await refreshHoloBattleMessage(
                request.id
              );

            } else {

              await refreshRequestMessage(
                request.id
              );

            }

          } catch (error) {

            console.error(
              `Failed to close request #${request.id}:`,
              error
            );
          }
        }
      }

    } catch (error) {

      console.error(
        'Timer error:',
        error
      );
    }
  },
  30 * 1000
);

client.on('messageCreate', async message => {
  try {
    if (message.author.bot) return;

    if (
      message.channelId !==
      process.env.PROFILE_CHANNEL_ID
    ) {
      return;
    }

    if (
      !waitingForProfilePhoto.has(
        message.author.id
      )
    ) {
      return;
    }

    const data =
      pendingProfiles.get(
        message.author.id
      );

    if (!data) {
      waitingForProfilePhoto.delete(
        message.author.id
      );
      return;
    }

    const attachments =
      [...message.attachments.values()];

    const images =
      attachments.filter(
        attachment =>
          attachment.contentType?.startsWith(
            'image/'
          ) ||
          /\.(png|jpe?g|gif|webp)$/i.test(
            attachment.name || ''
          )
      );

    if (
      attachments.length !== 1 ||
      images.length !== 1
    ) {
      await message.delete().catch(() => {});

      return;
    }

    const image = images[0];

    const response =
      await fetch(image.url);

    if (!response.ok) {
      throw new Error(
        'Failed to download profile photo.'
      );
    }

    const buffer =
      Buffer.from(
        await response.arrayBuffer()
      );

    const extension =
      image.name?.includes('.')
        ? image.name.slice(
            image.name.lastIndexOf('.')
          )
        : '.png';

    const fileName =
      `profile-photo${extension}`;

    const photoFile =
      new AttachmentBuilder(buffer)
        .setName(fileName);

    await publishProfile(
      data,
      null,
      photoFile
    );

    await message.delete().catch(() => {});

  } catch (error) {
    console.error(
      'Profile photo error:',
      error
    );
  }
});

client.login(
  process.env.DISCORD_TOKEN
);
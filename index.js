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
  'APAC_ROLE_ID'
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
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS participants (
      request_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      joined_at INTEGER NOT NULL,
      PRIMARY KEY (request_id, user_id)
    );
  `);

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
    GatewayIntentBits.Guilds
  ]
});

const pending = new Map();


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

function parseKyivDateTime(dateText, timeText) {
  const dateMatch = dateText.match(
    /^(\d{2})\.(\d{2})\.(\d{4})$/
  );

  const timeMatch = timeText.match(
    /^(\d{2}):(\d{2})$/
  );

  if (!dateMatch || !timeMatch) {
    return null;
  }

  const day = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const year = Number(dateMatch[3]);

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

  const utcGuess = Date.UTC(
    year,
    month - 1,
    day,
    hour,
    minute
  );

  const getKyivOffset = (timestamp) => {
    const parts = new Intl.DateTimeFormat(
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

    const localAsUtc = Date.UTC(
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

  const check = new Intl.DateTimeFormat(
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
    return null;
  }

  return timestamp;
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

function addParticipant(id, userId) {
  const request = getRequest(id);

  if (!request) {
    return {
      ok: false,
      reason: 'not_found'
    };
  }

  const participants = getParticipants(id);

  if (participants.includes(userId)) {
    return {
      ok: false,
      reason: 'already'
    };
  }

  if (participants.length >= 3) {
    return {
      ok: false,
      reason: 'full'
    };
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
  const servers = JSON.parse(request.servers);
  const difficulties = JSON.parse(request.difficulties);
  const participants = getParticipants(request.id);

  const finished =
    Date.now() >= request.scheduled_at + 60 * 60 * 1000;

  const participantText = participants.length
    ? participants
        .map(
          (userId, index) =>
            `${index + 1}. <@${userId}>`
        )
        .join('\n')
    : 'Поки що ніхто не приєднався.';

  const embed = new EmbedBuilder()
    .setTitle(
      `🥚 Egg Heist — ${request.nickname}`
    )
    .setDescription(
      finished
        ? '🔴 **Збір завершено.**'
        : 'Натисніть **Join**, щоб приєднатися до групи, або **Leave**, щоб вийти з неї.'
    )
    .addFields(
      {
        name: '👤 Нікнейм',
        value: request.nickname,
        inline: true
      },
      {
        name: '⚔️ Складність',
        value: difficulties.join(', '),
        inline: true
      },
      {
        name: '📅 Заплановано',
        value:
          `${formatKyivDateTime(request.scheduled_at)} (Київ)`,
        inline: false
      },
      {
        name: '⏰ Збір доступний до',
        value:
          `${formatKyivDateTime(
            request.scheduled_at +
            60 * 60 * 1000
          )} (Київ)`,
        inline: false
      },
      {
        name: '💬 Коментар',
        value: request.comment || '—',
        inline: false
      },
      {
        name: `👥 Гравці (${participants.length}/3)`,
        value: participantText,
        inline: false
      }
    )
    .setFooter({
      text:
        finished
          ? `Egg Heist request #${request.id} — завершено`
          : `Egg Heist request #${request.id}`
    });

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
      )
  );
}

async function refreshRequestMessage(requestId) {
  const request = getRequest(requestId);

  if (!request || !request.message_id) {
    return;
  }

  const channel = await client.channels.fetch(
    request.channel_id
  );

  if (!channel || !channel.isTextBased()) {
    return;
  }

  const message = await channel.messages.fetch(
    request.message_id
  );

  const participants = getParticipants(requestId);

  const servers = JSON.parse(request.servers);
    const isFinished =
    Date.now() >=
    request.scheduled_at +
    60 * 60 * 1000;

  await message.edit({
    content:
      roleMentions(servers),

    embeds: [
      buildRequestEmbed(request)
    ],

    components: [
      buildButtons(
        requestId,
        participants.length >= 3,
        isFinished
      )
    ],

    allowedMentions: {
      roles: [
        ...servers
          .map(server => CONFIG.roles[server])
          .filter(Boolean)
      ]
    }
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
    .setMaxLength(10)
    .setPlaceholder('05.10.2026');

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
              '❌ Неправильна дата або час.\n\nВикористовуйте формат:\n`05.10.2026` та `16:00`.',
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
                'Ця група вже заповнена (3/3).'
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

          await interaction.deferUpdate();

          await refreshRequestMessage(id);

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

          await interaction.deferUpdate();

          await refreshRequestMessage(id);

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
            await refreshRequestMessage(
              request.id
            );

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

client.login(
  process.env.DISCORD_TOKEN
);
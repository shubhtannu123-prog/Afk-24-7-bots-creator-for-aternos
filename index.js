"use strict";

const mineflayer = require("mineflayer");
const {
  Movements,
  pathfinder
} = require("mineflayer-pathfinder");

const express = require("express");
const https = require("https");

const {
  addLog,
  getLogs
} = require("./logger");

const config =
  require("./settings.json");

// ============================================================
// EXPRESS
// ============================================================

const app =
  express();

app.use(
  express.json({
    limit: "16kb"
  })
);

const PORT =
  Number(process.env.PORT) || 5000;

const MAX_ERRORS =
  25;

const START_STAGGER_MS =
  1500;

// ============================================================
// CONFIG VALIDATION
// ============================================================

if (
  !Array.isArray(config.servers) ||
  config.servers.length === 0
) {
  throw new Error(
    'settings.json must contain a non-empty "servers" array.'
  );
}

// ============================================================
// STATE STORAGE
// ============================================================

const states =
  new Map();

// ============================================================
// STATE KEY
// ============================================================

function makeKey(
  serverName,
  botName
) {
  return (
    `${serverName}::${botName}`
  );
}

// ============================================================
// CREATE BOT STATE
// ============================================================

function createState(
  server,
  botName
) {
  const serverName =
    String(
      server.name ||
      `${server.ip}:${server.port || 25565}`
    ).trim();

  const botKey =
    makeKey(
      serverName,
      botName
    );

  if (
    states.has(botKey)
  ) {
    throw new Error(
      `Duplicate bot connection: ${botKey}`
    );
  }

  return {

    key:
      botKey,

    serverName,

    host:
      String(server.ip),

    port:
      Number(server.port) ||
      25565,

    version:
      server.version ||
      undefined,

    auth:
      server.auth ||
      config["bot-account"]?.type ||
      "offline",

    password:
      server.password ||
      config["bot-account"]?.password ||
      "",

    botName,

    bot:
      null,

    movements:
      null,

    connected:
      false,

    connecting:
      false,

    manualStop:
      false,

    generation:
      0,

    reconnectTimer:
      null,

    movementTimer:
      null,

    lookTimer:
      null,

    jumpTimer:
      null,

    chatTimer:
      null,

    combatTimer:
      null,

    authTimer:
      null,

    reconnectAttempts:
      0,

    startTime:
      Date.now(),

    lastActivity:
      Date.now(),

    errors:
      [],

    eating:
      false
  };
}

// ============================================================
// BUILD ALL BOT CONNECTIONS
// ============================================================

for (
  const server of config.servers
) {

  if (
    !server ||
    !server.ip
  ) {
    throw new Error(
      "Every server needs an ip."
    );
  }

  if (
    !Array.isArray(server.bots) ||
    server.bots.length === 0
  ) {
    throw new Error(
      `Server "${server.name || server.ip}" needs a non-empty "bots" array.`
    );
  }

  const serverName =
    String(
      server.name ||
      `${server.ip}:${server.port || 25565}`
    ).trim();

  const names =
    [
      ...new Set(
        server.bots
          .map(
            name =>
              String(
                name
              ).trim()
          )
          .filter(Boolean)
      )
    ];

  if (
    !names.length
  ) {
    throw new Error(
      `Server "${serverName}" contains no valid bot names.`
    );
  }

  for (
    const botName of names
  ) {

    states.set(
      makeKey(
        serverName,
        botName
      ),

      createState(
        {
          ...server,
          name:
            serverName
        },
        botName
      )
    );
  }
}

if (
  states.size === 0
) {
  throw new Error(
    "No bot connections configured."
  );
}

// ============================================================
// LOGGING
// ============================================================

function log(
  message
) {
  const text =
    String(message);

  console.log(
    text
  );

  try {
    addLog(
      text
    );
  } catch (_) {}
}

function rememberError(
  state,
  error
) {
  const message =
    error instanceof Error
      ? (
          error.stack ||
          error.message
        )
      : String(error);

  state.errors.push({

    time:
      Date.now(),

    message:
      String(message).slice(
        0,
        2000
      )
  });

  if (
    state.errors.length >
    MAX_ERRORS
  ) {
    state.errors.splice(
      0,
      state.errors.length -
        MAX_ERRORS
    );
  }
}

function touch(
  state
) {
  state.lastActivity =
    Date.now();
}

function getUptime(
  state
) {
  return Math.max(
    0,
    Math.floor(
      (
        Date.now() -
        state.startTime
      ) / 1000
    )
  );
}

function escapeHTML(
  value
) {
  return String(
    value
  ).replace(
    /[&<>"']/g,
    char =>
      ({
        "&":
          "&amp;",

        "<":
          "&lt;",

        ">":
          "&gt;",

        '"':
          "&quot;",

        "'":
          "&#39;"
      })[char]
  );
}

// ============================================================
// FIND STATE
// ============================================================

function findState(
  serverName,
  botName
) {

  if (
    serverName &&
    botName
  ) {
    return (
      states.get(
        makeKey(
          serverName,
          botName
        )
      ) ||
      null
    );
  }

  if (
    botName
  ) {

    const matches =
      [
        ...states.values()
      ].filter(
        state =>
          state.botName ===
          botName
      );

    return (
      matches.length === 1
        ? matches[0]
        : null
    );
  }

  return (
    states.values()
      .next()
      .value ||
    null
  );
}

// ============================================================
// DISCORD
// ============================================================

function sendDiscord(
  state,
  event,
  message
) {

  try {

    if (
      !config.discord?.enabled
    ) {
      return;
    }

    if (
      !config.discord
        ?.events?.[event]
    ) {
      return;
    }

    if (
      !config.discord?.webhookUrl
    ) {
      return;
    }

    const url =
      new URL(
        config.discord.webhookUrl
      );

    const body =
      JSON.stringify({
        content:
          `[${state.serverName}] [${state.botName}] ${message}`
      });

    const request =
      https.request(
        {
          hostname:
            url.hostname,

          port:
            url.port ||
            443,

          path:
            url.pathname +
            url.search,

          method:
            "POST",

          headers: {

            "Content-Type":
              "application/json",

            "Content-Length":
              Buffer.byteLength(
                body
              )
          },

          timeout:
            5000

        },

        response => {
          response.resume();
        }
      );

    request.on(
      "error",
      () => {}
    );

    request.write(
      body
    );

    request.end();

  } catch (_) {}
}

// ============================================================
// RECONNECT
// ============================================================

function clearReconnect(
  state
) {

  if (
    state.reconnectTimer
  ) {

    clearTimeout(
      state.reconnectTimer
    );

    state.reconnectTimer =
      null;
  }
}

function getReconnectDelay(
  state
) {

  const base =
    Math.max(
      1000,
      Number(
        config.utils?.[
          "auto-reconnect-delay"
        ]
      ) || 2000
    );

  const maximum =
    Math.max(
      base,
      Number(
        config.utils?.[
          "max-reconnect-delay"
        ]
      ) || 120000
    );

  return Math.min(
    maximum,

    base *
      Math.pow(
        2,
        Math.min(
          state.reconnectAttempts,
          6
        )
      )
  );
}

function scheduleReconnect(
  state,
  reason = ""
) {

  if (
    !config.utils?.[
      "auto-reconnect"
    ]
  ) {
    return;
  }

  if (
    state.manualStop ||
    state.reconnectTimer ||
    state.connecting ||
    state.bot
  ) {
    return;
  }

  const delay =
    getReconnectDelay(
      state
    );

  state.reconnectAttempts++;

  log(
    `[${state.serverName}] [${state.botName}] reconnecting in ${Math.ceil(
      delay / 1000
    )}s${
      reason
        ? ` (${reason})`
        : ""
    }`
  );

  state.reconnectTimer =
    setTimeout(
      () => {

        state.reconnectTimer =
          null;

        startBot(
          state
        ).catch(
          error => {

            rememberError(
              state,
              error
            );

            scheduleReconnect(
              state,
              "retry failed"
            );
          }
        );

      },
      delay
    );

  state.reconnectTimer.unref?.();
}

// ============================================================
// MOVEMENT
// ============================================================

function stopMovement(
  state
) {

  if (
    state.movementTimer
  ) {

    clearTimeout(
      state.movementTimer
    );

    state.movementTimer =
      null;
  }

  if (
    state.bot
  ) {

    try {
      state.bot.clearControlStates();
    } catch (_) {}
  }
}

// ============================================================
// ANTI-AFK LOOP
// ============================================================
//
// Walk approximately 2 blocks.
// Stop.
// Turn right 90 degrees.
// Repeat.
//
// Distance is checked from the actual
// Minecraft position instead of relying
// only on a timer, so it stays closer
// to the requested 2-block movement.
//

function startCircleWalk(
  state
) {

  stopMovement(
    state
  );

  const settings =
    config.movement?.[
      "circle-walk"
    ];

  if (
    !config.movement?.enabled ||
    !config.utils?.[
      "anti-afk"
    ]?.enabled ||
    !settings?.enabled ||
    !state.bot
  ) {
    return;
  }

  const stepBlocks =
    Math.max(
      0.5,
      Number(
        settings[
          "step-blocks"
        ]
      ) || 2
    );

  const maxStepTime =
    Math.max(
      1000,
      Number(
        settings[
          "max-step-time"
        ]
      ) || 4000
    );

  const turnPause =
    Math.max(
      0,
      Number(
        settings[
          "turn-pause"
        ]
      ) || 150
    );

  const turnDirection =
    String(
      settings.turn ||
      "right"
    ).toLowerCase() ===
    "left"
      ? -1
      : 1;

  function walkStep() {

    const bot =
      state.bot;

    if (
      !bot ||
      !state.connected ||
      state.manualStop
    ) {

      stopMovement(
        state
      );

      return;
    }

    const start =
      bot.entity?.position;

    if (!start) {

      state.movementTimer =
        setTimeout(
          walkStep,
          500
        );

      return;
    }

    const startX =
      start.x;

    const startZ =
      start.z;

    const startTime =
      Date.now();

    try {

      bot.setControlState(
        "forward",
        true
      );

    } catch (_) {

      state.movementTimer =
        setTimeout(
          walkStep,
          1000
        );

      return;
    }

    const checkDistance =
      async () => {

        if (
          !state.bot ||
          state.bot !== bot ||
          !state.connected ||
          state.manualStop
        ) {

          stopMovement(
            state
          );

          return;
        }

        const pos =
          bot.entity?.position;

        const dx =
          pos
            ? pos.x -
              startX
            : 0;

        const dz =
          pos
            ? pos.z -
              startZ
            : 0;

        const distance =
          Math.sqrt(
            dx * dx +
            dz * dz
          );

        if (
          distance >=
            stepBlocks ||
          Date.now() -
            startTime >=
            maxStepTime
        ) {

          try {

            bot.setControlState(
              "forward",
              false
            );

            const currentYaw =
              Number(
                bot.entity?.yaw
              ) || 0;

            await bot.look(
              currentYaw +
                (
                  turnDirection *
                  Math.PI /
                  2
                ),
              0,
              true
            );

            touch(
              state
            );

          } catch (error) {

            rememberError(
              state,
              error
            );
          }

          state.movementTimer =
            setTimeout(
              walkStep,
              turnPause
            );

          return;
        }

        state.movementTimer =
          setTimeout(
            checkDistance,
            100
          );
      };

    state.movementTimer =
      setTimeout(
        checkDistance,
        100
      );
  }

  walkStep();

  log(
    `[${state.serverName}] [${state.botName}] anti-AFK loop started: ${stepBlocks} blocks -> ${turnDirection === 1 ? "right" : "left"} -> repeat`
  );
}

// ============================================================
// SNEAK
// ============================================================

function startSneak(
  state
) {

  if (
    !config.utils?.[
      "anti-afk"
    ]?.sneak ||
    !state.bot
  ) {
    return;
  }

  try {

    state.bot.setControlState(
      "sneak",
      true
    );

  } catch (_) {}
}

// ============================================================
// LOOK AROUND
// ============================================================

function startLookAround(
  state
) {

  if (
    !config.movement?.[
      "look-around"
    ]?.enabled
  ) {
    return;
  }

  const interval =
    Math.max(
      1000,
      Number(
        config.movement[
          "look-around"
        ].interval
      ) || 5000
    );

  if (
    state.lookTimer
  ) {
    clearInterval(
      state.lookTimer
    );
  }

  state.lookTimer =
    setInterval(
      async () => {

        if (
          !state.bot ||
          !state.connected
        ) {
          return;
        }

        try {

          const yaw =
            Number(
              state.bot
                .entity?.yaw
            ) || 0;

          await state.bot.look(
            yaw +
              (
                Math.random() -
                0.5
              ) *
                Math.PI,

            0,

            false
          );

          touch(
            state
          );

        } catch (_) {}

      },
      interval
    );

  state.lookTimer.unref?.();
}

// ============================================================
// RANDOM JUMP
// ============================================================

function startRandomJump(
  state
) {

  if (
    !config.movement?.[
      "random-jump"
    ]?.enabled
  ) {
    return;
  }

  const interval =
    Math.max(
      2000,
      Number(
        config.movement[
          "random-jump"
        ].interval
      ) || 10000
    );

  if (
    state.jumpTimer
  ) {
    clearInterval(
      state.jumpTimer
    );
  }

  state.jumpTimer =
    setInterval(
      () => {

        if (
          !state.bot ||
          !state.connected
        ) {
          return;
        }

        try {

          state.bot.setControlState(
            "jump",
            true
          );

          setTimeout(
            () => {

              if (
                !state.bot
              ) {
                return;
              }

              try {

                state.bot.setControlState(
                  "jump",
                  false
                );

              } catch (_) {}

            },
            150
          );

        } catch (_) {}

      },
      interval
    );

  state.jumpTimer.unref?.();
}

// ============================================================
// AUTO AUTH
// ============================================================

function runAutoAuth(
  state
) {

  if (
    !config.utils?.[
      "auto-auth"
    ]?.enabled ||
    !state.bot
  ) {
    return;
  }

  const password =
    String(
      config.utils[
        "auto-auth"
      ].password ||
      state.password ||
      ""
    );

  if (
    !password
  ) {
    return;
  }

  if (
    state.authTimer
  ) {
    clearTimeout(
      state.authTimer
    );
  }

  state.authTimer =
    setTimeout(
      () => {

        state.authTimer =
          null;

        if (
          !state.bot ||
          !state.connected
        ) {
          return;
        }

        try {

          state.bot.chat(
            `/login ${password}`
          );

          touch(
            state
          );

          log(
            `[${state.serverName}] [${state.botName}] auto-auth sent.`
          );

        } catch (error) {

          rememberError(
            state,
            error
          );
        }

      },
      2000
    );
}

// ============================================================
// REPEATED CHAT
// ============================================================

function startChatMessages(
  state
) {

  const settings =
    config.utils?.[
      "chat-messages"
    ];

  if (
    !settings?.enabled ||
    !settings.repeat ||
    !Array.isArray(
      settings.messages
    ) ||
    !settings.messages.length
  ) {
    return;
  }

  const interval =
    Math.max(
      1000,
      (
        Number(
          settings[
            "repeat-delay"
          ]
        ) || 120
      ) *
        1000
    );

  if (
    state.chatTimer
  ) {
    clearInterval(
      state.chatTimer
    );
  }

  state.chatTimer =
    setInterval(
      () => {

        if (
          !state.bot ||
          !state.connected
        ) {
          return;
        }

        try {

          const index =
            Math.floor(
              Math.random() *
                settings.messages.length
            );

          const message =
            String(
              settings.messages[
                index
              ]
            ).slice(
              0,
              256
            );

          state.bot.chat(
            message
          );

          touch(
            state
          );

        } catch (error) {

          rememberError(
            state,
            error
          );
        }

      },
      interval
    );

  state.chatTimer.unref?.();
}

// ============================================================
// FOOD
// ============================================================

const foodNames =
  new Set([
    "bread",
    "cooked_beef",
    "cooked_porkchop",
    "cooked_chicken",
    "cooked_mutton",
    "cooked_rabbit",
    "cooked_cod",
    "cooked_salmon",
    "baked_potato",
    "carrot",
    "golden_carrot",
    "apple",
    "melon_slice",
    "sweet_berries",
    "glow_berries",
    "beetroot",
    "potato",
    "pumpkin_pie",
    "cookie"
  ]);

async function tryEat(
  state
) {

  if (
    state.eating ||
    !state.bot ||
    !state.connected
  ) {
    return;
  }

  if (
    !config.combat?.[
      "auto-eat"
    ]
  ) {
    return;
  }

  if (
    Number(
      state.bot.food
    ) > 12
  ) {
    return;
  }

  const item =
    state.bot.inventory
      .items()
      .find(
        item =>
          foodNames.has(
            item.name
          )
      );

  if (!item) {
    return;
  }

  state.eating =
    true;

  try {

    await state.bot.equip(
      item,
      "hand"
    );

    await state.bot.consume();

    touch(
      state
    );

    log(
      `[${state.serverName}] [${state.botName}] ate ${item.name}.`
    );

  } catch (error) {

    rememberError(
      state,
      error
    );

  } finally {

    state.eating =
      false;
  }
}

// ============================================================
// COMBAT
// ============================================================

const hostileMobs =
  new Set([
    "zombie",
    "skeleton",
    "spider",
    "creeper",
    "witch",
    "enderman",
    "drowned",
    "husk",
    "stray",
    "pillager",
    "vindicator",
    "ravager",
    "phantom",
    "silverfish",
    "cave_spider"
  ]);

function startCombat(
  state
) {

  if (
    !config.modules?.combat ||
    !config.combat?.[
      "attack-mobs"
    ]
  ) {
    return;
  }

  const interval =
    Math.max(
      250,
      Number(
        config.combat[
          "attack-delay"
        ]
      ) || 1000
    );

  const range =
    Number(
      config.combat[
        "attack-range"
      ]
    ) || 3.5;

  if (
    state.combatTimer
  ) {
    clearInterval(
      state.combatTimer
    );
  }

  state.combatTimer =
    setInterval(
      () => {

        if (
          !state.bot ||
          !state.connected ||
          !state.bot.entity
        ) {
          return;
        }

        try {

          const target =
            state.bot.nearestEntity(
              entity => {

                if (
                  !entity ||
                  entity.type !==
                    "mob"
                ) {
                  return false;
                }

                if (
                  !hostileMobs.has(
                    String(
                      entity.name ||
                      ""
                    ).toLowerCase()
                  )
                ) {
                  return false;
                }

                if (
                  !entity.position
                ) {
                  return false;
                }

                return (
                  state.bot.entity.position
                    .distanceTo(
                      entity.position
                    ) <=
                  range
                );
              }
            );

          if (
            target
          ) {

            state.bot.attack(
              target
            );

            touch(
              state
            );
          }

        } catch (error) {

          rememberError(
            state,
            error
          );
        }

        try {

          tryEat(
            state
          ).catch(
            error =>
              rememberError(
                state,
                error
              )
          );

        } catch (_) {}

      },
      interval
    );

  state.combatTimer.unref?.();
}

// ============================================================
// CHAT
// ============================================================

function handleChat(
  state,
  username,
  message
) {

  if (
    config.utils?.[
      "chat-log"
    ]
  ) {

    log(
      `[${state.serverName}] [${state.botName}] <${username}> ${message}`
    );
  }

  if (
    config.discord?.events?.chat
  ) {

    sendDiscord(
      state,
      "chat",
      `<${username}> ${message}`
    );
  }

  if (
    !config.chat?.respond ||
    username ===
      state.botName
  ) {
    return;
  }

  const text =
    String(
      message
    )
      .trim()
      .toLowerCase();

  if (
    text === "hi" ||
    text === "hello" ||
    text === "hey"
  ) {

    try {

      state.bot.chat(
        `Hello ${username}!`
      );

    } catch (_) {}
  }
}

// ============================================================
// CLEANUP
// ============================================================

function cleanupBot(
  state,
  reason = "cleanup"
) {

  stopMovement(
    state
  );

  if (
    state.lookTimer
  ) {

    clearInterval(
      state.lookTimer
    );

    state.lookTimer =
      null;
  }

  if (
    state.jumpTimer
  ) {

    clearInterval(
      state.jumpTimer
    );

    state.jumpTimer =
      null;
  }

  if (
    state.chatTimer
  ) {

    clearInterval(
      state.chatTimer
    );

    state.chatTimer =
      null;
  }

  if (
    state.combatTimer
  ) {

    clearInterval(
      state.combatTimer
    );

    state.combatTimer =
      null;
  }

  if (
    state.authTimer
  ) {

    clearTimeout(
      state.authTimer
    );

    state.authTimer =
      null;
  }

  const oldBot =
    state.bot;

  state.bot =
    null;

  state.movements =
    null;

  state.connected =
    false;

  state.eating =
    false;

  if (
    !oldBot
  ) {
    return;
  }

  try {
    oldBot.clearControlStates();
  } catch (_) {}

  try {
    oldBot.quit(
      reason
    );
  } catch (_) {}

  try {
    oldBot._client
      ?.socket
      ?.destroy();
  } catch (_) {}
}

// ============================================================
// EVENT REGISTRATION
// ============================================================

function registerEvents(
  state,
  bot,
  generation
) {

  bot.on(
    "login",
    () => {

      if (
        generation !==
        state.generation
      ) {
        return;
      }

      touch(
        state
      );

      log(
        `[${state.serverName}] [${state.botName}] logged in.`
      );
    }
  );

  bot.once(
    "spawn",
    () => {

      if (
        generation !==
          state.generation ||
        bot !==
          state.bot
      ) {
        return;
      }

      state.connected =
        true;

      state.reconnectAttempts =
        0;

      state.startTime =
        Date.now();

      touch(
        state
      );

      // ------------------------------------------------------
      // PATHFINDER
      // ------------------------------------------------------

      try {

        state.movements =
          new Movements(
            bot
          );

        state.movements.canDig =
          false;

        state.movements.allow1by1towers =
          false;

        state.movements.allowFreeMotion =
          false;

        bot.pathfinder
          .setMovements(
            state.movements
          );

      } catch (error) {

        rememberError(
          state,
          error
        );

        log(
          `[${state.serverName}] [${state.botName}] pathfinder warning: ${
            error?.message ||
            error
          }`
        );
      }

      // ------------------------------------------------------
      // FEATURES
      // ------------------------------------------------------

      startCircleWalk(
        state
      );

      startSneak(
        state
      );

      startLookAround(
        state
      );

      startRandomJump(
        state
      );

      startChatMessages(
        state
      );

      startCombat(
        state
      );

      runAutoAuth(
        state
      );

      sendDiscord(
        state,
        "connect",
        "Connected."
      );

      log(
        `[${state.serverName}] [${state.botName}] spawned successfully.`
      );
    }
  );

  bot.on(
    "chat",
    (
      username,
      message
    ) => {

      if (
        generation !==
        state.generation
      ) {
        return;
      }

      touch(
        state
      );

      handleChat(
        state,
        username,
        message
      );
    }
  );

  bot.on(
    "whisper",
    (
      username,
      message
    ) => {

      if (
        generation !==
        state.generation
      ) {
        return;
      }

      if (
        config.utils?.[
          "chat-log"
        ]
      ) {

        log(
          `[${state.serverName}] [${state.botName}] [WHISPER] <${username}> ${message}`
        );
      }

      touch(
        state
      );
    }
  );

  bot.on(
    "kicked",
    reason => {

      if (
        generation !==
        state.generation
      ) {
        return;
      }

      let text;

      try {

        text =
          typeof reason ===
          "string"
            ? reason
            : JSON.stringify(
                reason
              );

      } catch (_) {

        text =
          String(
            reason
          );
      }

      state.connected =
        false;

      log(
        `[${state.serverName}] [${state.botName}] kicked: ${text}`
      );

      sendDiscord(
        state,
        "disconnect",
        `Kicked: ${text}`
      );
    }
  );

  bot.on(
    "error",
    error => {

      if (
        generation !==
        state.generation
      ) {
        return;
      }

      rememberError(
        state,
        error
      );

      log(
        `[${state.serverName}] [${state.botName}] error: ${
          error?.message ||
          error
        }`
      );
    }
  );

  bot.on(
    "end",
    reason => {

      if (
        generation !==
        state.generation
      ) {
        return;
      }

      cleanupBot(
        state,
        "connection ended"
      );

      log(
        `[${state.serverName}] [${state.botName}] connection ended${
          reason
            ? `: ${reason}`
            : ""
        }`
      );

      sendDiscord(
        state,
        "disconnect",
        "Disconnected."
      );

      scheduleReconnect(
        state,
        "connection ended"
      );
    }
  );
}

// ============================================================
// START BOT
// ============================================================

async function startBot(
  state
) {

  if (
    state.connecting ||
    state.bot ||
    state.manualStop
  ) {
    return false;
  }

  clearReconnect(
    state
  );

  state.connecting =
    true;

  const generation =
    ++state.generation;

  try {

    log(
      `[${state.serverName}] [${state.botName}] connecting to ${state.host}:${state.port}...`
    );

    const options = {

      host:
        state.host,

      port:
        state.port,

      username:
        state.botName,

      auth:
        state.auth,

      version:
        state.version,

      password:
        state.password ||
        undefined,

      // ------------------------------------------------------
      // WISPBYTE MEMORY PROTECTION
      // ------------------------------------------------------

      viewDistance:
        Math.max(
          2,
          Number(
            config.performance?.viewDistance
          ) || 2
        ),

      physicsEnabled:
        config.performance
          ?.physicsEnabled !==
        false,

      chatLog:
        false,

      connectTimeout:
        Math.max(
          5000,
          Number(
            config.performance?.connectTimeout
          ) || 30000
        ),

      checkTimeoutInterval:
        Math.max(
          5000,
          Number(
            config.performance?.checkTimeoutInterval
          ) || 30000
        ),

      hideErrors:
        false
    };

    const bot =
      mineflayer.createBot(
        options
      );

    state.bot =
      bot;

    bot.loadPlugin(
      pathfinder
    );

    registerEvents(
      state,
      bot,
      generation
    );

    return true;

  } catch (error) {

    state.bot =
      null;

    rememberError(
      state,
      error
    );

    log(
      `[${state.serverName}] [${state.botName}] start failed: ${
        error?.message ||
        error
      }`
    );

    scheduleReconnect(
      state,
      "start failed"
    );

    return false;

  } finally {

    state.connecting =
      false;
  }
}

// ============================================================
// STOP BOT
// ============================================================

async function stopBot(
  state
) {

  state.manualStop =
    true;

  clearReconnect(
    state
  );

  state.generation++;

  cleanupBot(
    state,
    "dashboard stop"
  );

  state.reconnectAttempts =
    0;

  log(
    `[${state.serverName}] [${state.botName}] stopped.`
  );
}

// ============================================================
// DASHBOARD
// ============================================================

app.get(
  "/",
  (req, res) => {

    const groups =
      new Map();

    for (
      const state
      of states.values()
    ) {

      if (
        !groups.has(
          state.serverName
        )
      ) {

        groups.set(
          state.serverName,
          []
        );
      }

      groups
        .get(
          state.serverName
        )
        .push(
          state
        );
    }

    let html =
      "";

    for (
      const [
        serverName,
        list
      ]
      of groups
    ) {

      html +=
        `<section class="card">
          <h2>${escapeHTML(
            serverName
          )}</h2>`;

      for (
        const state
        of list
      ) {

        const pos =
          state.bot
            ?.entity
            ?.position;

        const position =
          pos
            ? `X ${Math.floor(
                pos.x
              )}, Y ${Math.floor(
                pos.y
              )}, Z ${Math.floor(
                pos.z
              )}`
            : "Unavailable";

        html +=
          `<div class="bot ${
            state.connected
              ? "online"
              : "offline"
          }">

            <div class="top">

              <strong>
                ${escapeHTML(
                  state.botName
                )}
              </strong>

              <span>
                ${
                  state.connected
                    ? "CONNECTED"
                    : state.connecting
                      ? "CONNECTING"
                      : "OFFLINE"
                }
              </span>

            </div>

            <div class="info">
              Position: ${escapeHTML(
                position
              )}
            </div>

            <div class="info">
              Uptime: ${getUptime(
                state
              )}s
            </div>

            <div class="actions">

              <button
                type="button"
                class="bot-action"
                data-action="/start"
                data-server="${escapeHTML(
                  state.serverName
                )}"
                data-bot="${escapeHTML(
                  state.botName
                )}">
                Start
              </button>

              <button
                type="button"
                class="bot-action"
                data-action="/stop"
                data-server="${escapeHTML(
                  state.serverName
                )}"
                data-bot="${escapeHTML(
                  state.botName
                )}">
                Stop
              </button>

            </div>

          </div>`;
      }

      html +=
        `</section>`;
    }

    res.set(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate"
    );

    res.send(
      `<!doctype html>

<html>

<head>

<meta charset="utf-8">

<meta
name="viewport"
content="width=device-width,initial-scale=1">

<title>
Multi-Server Bot Dashboard
</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  padding: 24px;
  background: #0d1117;
  color: #e6edf3;
  font-family: Arial, sans-serif;
}

main {
  max-width: 850px;
  margin: auto;
}

.card {
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 12px;
  padding: 18px;
  margin: 14px 0;
}

.bot {
  border: 1px solid #30363d;
  border-radius: 10px;
  padding: 14px;
  margin-top: 10px;
}

.bot.online {
  border-color: #238636;
}

.bot.offline {
  border-color: #da3633;
}

.top {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}

.top span {
  font-size: 12px;
  color: #8b949e;
}

.info {
  margin-top: 7px;
  color: #8b949e;
  font-size: 13px;
}

.actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
  flex-wrap: wrap;
}

button,
a {
  border: 1px solid #30363d;
  background: #161b22;
  color: #e6edf3;
  border-radius: 8px;
  padding: 9px 14px;
  cursor: pointer;
  text-decoration: none;
  font: inherit;
  -webkit-tap-highlight-color: transparent;
}

button:hover,
a:hover {
  background: #21262d;
}

button:active,
a:active {
  transform: translateY(1px);
}

button:disabled {
  opacity: 0.6;
  cursor: wait;
  transform: none;
}

#toast {
  position: fixed;
  left: 50%;
  bottom: 22px;
  transform: translateX(-50%) translateY(20px);
  background: #161b22;
  color: #e6edf3;
  border: 1px solid #30363d;
  border-radius: 10px;
  padding: 10px 14px;
  opacity: 0;
  pointer-events: none;
  transition: opacity .18s ease, transform .18s ease;
  max-width: min(90vw, 700px);
  z-index: 9999;
}

#toast.show {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}

</style>

</head>

<body>

<main>

<h1>
Multi-Server Minecraft Bot Dashboard
</h1>

<p>
${states.size}
configured bot connection(s)
</p>

${html}

<div class="card">

<a href="/logs">
Logs
</a>

<a href="/health">
Health
</a>

<a href="/tutorial">
Setup
</a>

</div>

</main>

<div
id="toast"
role="status"
aria-live="polite">
</div>

<script>

(function () {

  const toast =
    document.getElementById(
      "toast"
    );

  let toastTimer =
    null;

  function showToast(
    message
  ) {

    if (!toast) {
      return;
    }

    toast.textContent =
      String(message || "");

    toast.classList.add(
      "show"
    );

    clearTimeout(
      toastTimer
    );

    toastTimer =
      setTimeout(
        () => {
          toast.classList.remove(
            "show"
          );
        },
        2800
      );
  }

  function sleep(
    ms
  ) {
    return new Promise(
      resolve =>
        setTimeout(
          resolve,
          ms
        )
    );
  }

  async function requestAction(
    url,
    server,
    bot
  ) {

    let lastError =
      null;

    for (
      let attempt = 0;
      attempt < 3;
      attempt++
    ) {

      const controller =
        new AbortController();

      const timeout =
        setTimeout(
          () =>
            controller.abort(),
          20000
        );

      try {

        const response =
          await fetch(
            url,
            {
              method:
                "POST",

              headers: {
                "Content-Type":
                  "application/json",
                "Accept":
                  "application/json"
              },

              cache:
                "no-store",

              credentials:
                "same-origin",

              body:
                JSON.stringify({
                  server,
                  bot
                }),

              signal:
                controller.signal
            }
          );

        const contentType =
          response.headers.get(
            "content-type"
          ) || "";

        const raw =
          await response.text();

        if (
          contentType.includes(
            "application/json"
          )
        ) {

          let data;

          try {
            data =
              JSON.parse(raw);
          } catch (error) {
            lastError =
              new Error(
                "Server returned invalid JSON."
              );
          }

          if (data) {

            if (
              !response.ok
            ) {

              throw new Error(
                data.msg ||
                "Request failed (" +
                response.status +
                ")."
              );
            }

            return data;
          }

        } else {

          lastError =
            new Error(
              response.status === 503 ||
              response.status === 502
                ? "Render is waking the service..."
                : "Unexpected server response (" +
                  response.status +
                  ")."
            );
        }

      } catch (error) {

        lastError =
          error?.name === "AbortError"
            ? new Error(
                "The request timed out."
              )
            : error;

      } finally {

        clearTimeout(
          timeout
        );
      }

      // A sleeping Render service can return
      // a wake-up page before the Node app is ready.
      if (
        attempt < 2
      ) {

        showToast(
          attempt === 0
            ? "Connecting to the bot service..."
            : "Retrying..."
        );

        await sleep(
          4500
        );
      }
    }

    throw (
      lastError ||
      new Error(
        "Request failed."
      )
    );
  }

  async function act(
    button
  ) {

    if (
      !button ||
      button.disabled
    ) {
      return;
    }

    const url =
      button.dataset.action;

    const server =
      button.dataset.server;

    const bot =
      button.dataset.bot;

    if (
      !url ||
      !server ||
      !bot
    ) {

      showToast(
        "This button is missing its bot information."
      );

      return;
    }

    const originalText =
      button.textContent.trim();

    button.disabled =
      true;

    button.textContent =
      "Working...";

    try {

      const data =
        await requestAction(
          url,
          server,
          bot
        );

      showToast(
        data.msg ||
        "Done"
      );

      setTimeout(
        () =>
          window.location.reload(),
        500
      );

    } catch (error) {

      showToast(
        error?.message ||
        "Request failed."
      );

      button.disabled =
        false;

      button.textContent =
        originalText;
    }
  }

  // Event delegation means dynamically rendered
  // buttons remain clickable and there are no
  // fragile inline onclick handlers.
  document.addEventListener(
    "click",
    event => {

      const button =
        event.target.closest(
          ".bot-action"
        );

      if (
        !button
      ) {
        return;
      }

      event.preventDefault();

      act(
        button
      );
    }
  );

})();

</script>

</body>

</html>`
    );
  }
);


// ============================================================
// HEALTH
// ============================================================

app.get(
  "/health",
  (req, res) => {

    const result =
      {};

    for (
      const state
      of states.values()
    ) {

      const pos =
        state.bot
          ?.entity
          ?.position;

      result[
        state.key
      ] = {

        server:
          state.serverName,

        bot:
          state.botName,

        host:
          state.host,

        port:
          state.port,

        status:
          state.connected
            ? "connected"
            : "disconnected",

        connecting:
          state.connecting,

        uptime:
          getUptime(
            state
          ),

        coords:
          pos
            ? {
                x:
                  Number(pos.x),

                y:
                  Number(pos.y),

                z:
                  Number(pos.z)
              }
            : null,

        reconnectAttempts:
          state.reconnectAttempts,

        errors:
          state.errors
      };
    }

    res.set(
      "Cache-Control",
      "no-store"
    );

    res.json({

      count:
        states.size,

      bots:
        result

    });
  }
);

// ============================================================
// PING
// ============================================================

app.get(
  "/ping",
  (req, res) => {

    res.set(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate"
    );

    res.send(
      "pong"
    );
  }
);

app.get(
  "/keepalive",
  (req, res) => {

    res.set(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate"
    );

    res.status(200).json({
      ok: true,
      service: "minecraft-bot-dashboard",
      uptime: Math.floor(process.uptime())
    });
  }
);

// ============================================================
// COMMAND PARSER
// ============================================================

function parseCommand(
  raw
) {

  const parts =
    raw
      .trim()
      .split(
        /\s+/
      );

  const command =
    (
      parts.shift() ||
      ""
    ).toLowerCase();

  let serverName =
    null;

  let botName =
    null;

  /*
   * /status Aternos Chomubot
   */

  if (
    parts.length >= 2 &&
    states.has(
      makeKey(
        parts[0],
        parts[1]
      )
    )
  ) {

    serverName =
      parts.shift();

    botName =
      parts.shift();

  /*
   * /status Chomubot
   *
   * Works only if that name exists
   * on exactly one server.
   */

  } else if (
    parts[0] &&
    [
      ...states.values()
    ].some(
      state =>
        state.botName ===
        parts[0]
    )
  ) {

    botName =
      parts.shift();
  }

  return {

    command,

    state:
      findState(
        serverName,
        botName
      ),

    rest:
      parts.join(
        " "
      )

  };
}

function commandHelp() {

  return [
    "/help",
    "/status ServerName BotName",
    "/pos ServerName BotName",
    "/list ServerName BotName",
    "/say ServerName BotName message",
    "Normal text = chat"
  ].join(
    "\n"
  );
}

// ============================================================
// COMMAND ENDPOINT
// ============================================================

app.post(
  "/command",
  (req, res) => {

    if (
      !config.modules?.[
        "console-commands"
      ]
    ) {

      return res.json({

        success:
          false,

        msg:
          "Console commands are disabled."

      });
    }

    const raw =
      typeof req.body?.command ===
      "string"
        ? req.body.command.trim()
        : "";

    if (
      !raw
    ) {

      return res.json({

        success:
          false,

        msg:
          "No command supplied."

      });
    }

    const {
      command,
      state,
      rest
    } =
      parseCommand(
        raw
      );

    if (
      !state
    ) {

      return res.json({

        success:
          false,

        msg:
          "Could not identify the bot. Use: /status ServerName BotName"

      });
    }

    // --------------------------------------------------------
    // HELP
    // --------------------------------------------------------

    if (
      command ===
      "/help"
    ) {

      return res.json({

        success:
          true,

        msg:
          commandHelp()

      });
    }

    // --------------------------------------------------------
    // STATUS
    // --------------------------------------------------------

    if (
      command ===
      "/status"
    ) {

      return res.json({

        success:
          true,

        msg:
          `${state.serverName} / ${state.botName}\n` +
          `Status: ${
            state.connected
              ? "Connected"
              : "Disconnected"
          }\n` +
          `Connecting: ${
            state.connecting
          }\n` +
          `Uptime: ${
            getUptime(
              state
            )
          }s\n` +
          `Reconnects: ${
            state.reconnectAttempts
          }\n` +
          `RAM: ${
            Math.round(
              process
                .memoryUsage()
                .heapUsed /
              1024 /
              1024
            )
          } MB`

      });
    }

    // --------------------------------------------------------
    // POSITION
    // --------------------------------------------------------

    if (
      command ===
      "/pos"
    ) {

      const pos =
        state.bot
          ?.entity
          ?.position;

      if (
        !pos
      ) {

        return res.json({

          success:
            false,

          msg:
            `${state.botName} has no position yet.`

        });
      }

      return res.json({

        success:
          true,

        msg:
          `${state.serverName} / ${state.botName}: ` +
          `X ${Math.floor(
            pos.x
          )}, ` +
          `Y ${Math.floor(
            pos.y
          )}, ` +
          `Z ${Math.floor(
            pos.z
          )}`

      });
    }

    // --------------------------------------------------------
    // LIST
    // --------------------------------------------------------

    if (
      command ===
      "/list"
    ) {

      if (
        !state.bot
      ) {

        return res.json({

          success:
            false,

          msg:
            `${state.botName} is not connected.`

        });
      }

      const players =
        Object.keys(
          state.bot.players ||
          {}
        ).filter(
          name =>
            name !==
            state.botName
        );

      return res.json({

        success:
          true,

        msg:
          players.length
            ? `${state.botName}: ${players.join(
                ", "
              )}`
            : `${state.botName}: no other players detected.`

      });
    }

    // --------------------------------------------------------
    // SAY
    // --------------------------------------------------------

    if (
      command ===
      "/say"
    ) {

      if (
        !state.bot ||
        !state.connected
      ) {

        return res.json({

          success:
            false,

          msg:
            `${state.botName} is not connected.`

        });
      }

      if (
        !rest
      ) {

        return res.json({

          success:
            false,

          msg:
            "/say ServerName BotName message"

        });
      }

      const message =
        rest.slice(
          0,
          256
        );

      state.bot.chat(
        message
      );

      touch(
        state
      );

      return res.json({

        success:
          true,

        msg:
          `${state.botName} sent: ${message}`

      });
    }

    // --------------------------------------------------------
    // NORMAL CHAT
    // --------------------------------------------------------

    if (
      !state.bot ||
      !state.connected
    ) {

      return res.json({

        success:
          false,

        msg:
          `${state.botName} is not connected.`

      });
    }

    state.bot.chat(
      raw.slice(
        0,
        256
      )
    );

    touch(
      state
    );

    return res.json({

      success:
        true,

      msg:
        `${state.botName} sent the message.`

    });
  }
);

// ============================================================
// START ENDPOINT
// ============================================================

app.post(
  "/start",
  async (req, res) => {

    const serverName =
      req.body?.server
        ? String(
            req.body.server
          )
        : null;

    const botName =
      req.body?.bot
        ? String(
            req.body.bot
          )
        : null;

    // --------------------------------------------------------
    // START ONE
    // --------------------------------------------------------

    if (
      serverName ||
      botName
    ) {

      const state =
        findState(
          serverName,
          botName
        );

      if (
        !state
      ) {

        return res
          .status(404)
          .json({

            success:
              false,

            msg:
              "Unknown server/bot."

          });
      }

      state.manualStop =
        false;

      const started = await startBot(
        state
      );

      return res.status(started || state.bot || state.connecting ? 200 : 503).json({

        success:
          Boolean(started || state.bot || state.connecting),

        msg:
          started
            ? `${state.serverName} / ${state.botName} start requested.`
            : state.bot
              ? `${state.serverName} / ${state.botName} is already running.`
              : state.connecting
                ? `${state.serverName} / ${state.botName} is already connecting.`
                : `${state.serverName} / ${state.botName} could not start; check logs.`

      });
    }

    // --------------------------------------------------------
    // START ALL
    // --------------------------------------------------------

    for (
      const state
      of states.values()
    ) {

      state.manualStop =
        false;

      if (
        !state.bot &&
        !state.connecting
      ) {

        startBot(
          state
        ).catch(
          error => {

            rememberError(
              state,
              error
            );

            scheduleReconnect(
              state,
              "bulk start failed"
            );
          }
        );
      }
    }

    return res.json({

      success:
        true,

      msg:
        `Starting ${states.size} bot connection(s).`

    });
  }
);

// ============================================================
// STOP ENDPOINT
// ============================================================

app.post(
  "/stop",
  async (req, res) => {

    const serverName =
      req.body?.server
        ? String(
            req.body.server
          )
        : null;

    const botName =
      req.body?.bot
        ? String(
            req.body.bot
          )
        : null;

    // --------------------------------------------------------
    // STOP ONE
    // --------------------------------------------------------

    if (
      serverName ||
      botName
    ) {

      const state =
        findState(
          serverName,
          botName
        );

      if (
        !state
      ) {

        return res
          .status(404)
          .json({

            success:
              false,

            msg:
              "Unknown server/bot."

          });
      }

      await stopBot(
        state
      );

      return res.json({

        success:
          true,

        msg:
          `${state.serverName} / ${state.botName} stopped.`

      });
    }

    // --------------------------------------------------------
    // STOP ALL
    // --------------------------------------------------------

    for (
      const state
      of states.values()
    ) {

      await stopBot(
        state
      );
    }

    return res.json({

      success:
        true,

      msg:
        "All bots stopped."

    });
  }
);

// ============================================================
// LOGS
// ============================================================

app.get(
  "/logs",
  (req, res) => {

    let logs =
      [];

    try {

      logs =
        getLogs() ||
        [];

    } catch (_) {}

    logs =
      logs.slice(
        -250
      );

    const html =
      logs.length
        ? logs
            .map(
              entry =>
                escapeHTML(
                  entry
                )
            )
            .join(
              "\n"
            )
        : "No logs yet.";

    res.send(
      `<!doctype html>

<html>

<head>

<meta charset="utf-8">

<meta
name="viewport"
content="width=device-width,initial-scale=1">

<title>
Logs
</title>

<style>

body {
  margin: 0;
  padding: 20px;
  background: #0d1117;
  color: #e6edf3;
  font-family: Consolas, monospace;
}

main {
  max-width: 1000px;
  margin: auto;
}

a {
  color: #58a6ff;
}

pre {
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 12px;
  padding: 18px;
  white-space: pre-wrap;
  max-height: 75vh;
  overflow: auto;
}

</style>

</head>

<body>

<main>

<a href="/">
← Dashboard
</a>

<h1>
Logs
</h1>

<pre>
${html}
</pre>

</main>

</body>

</html>`
    );
  }
);

// ============================================================
// TUTORIAL
// ============================================================

app.get(
  "/tutorial",
  (req, res) => {

    res.send(
      `<!doctype html>

<html>

<head>

<meta charset="utf-8">

<meta
name="viewport"
content="width=device-width,initial-scale=1">

<title>
Multi-Bot Setup
</title>

<style>

body {
  background: #0d1117;
  color: #e6edf3;
  font-family: Arial, sans-serif;
  padding: 30px;
}

main {
  max-width: 760px;
  margin: auto;
}

.card {
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 12px;
  padding: 20px;
  margin: 14px 0;
}

p {
  color: #8b949e;
  line-height: 1.6;
}

code,
pre {
  background: #21262d;
  padding: 5px;
  border-radius: 5px;
}

a {
  color: #58a6ff;
}

</style>

</head>

<body>

<main>

<a href="/">
← Dashboard
</a>

<h1>
Multi-Server Setup
</h1>

<div class="card">

<h2>
Add Bots
</h2>

<p>
Edit the bots array inside a server.
</p>

<pre>
"bots": [
  "Chomubot",
  "ChowminBot",
  "MyCustomBot"
]
</pre>

</div>

<div class="card">

<h2>
Add Servers
</h2>

<p>
Add another object to the servers array.
Each server can have its own IP,
port, version and bot names.
</p>

</div>

<div class="card">

<h2>
Anti-AFK
</h2>

<p>
Each bot walks approximately 2 blocks,
turns right 90 degrees and repeats.
</p>

</div>

<div class="card">

<h2>
RAM Protection
</h2>

<p>
The bot clients use low view distance,
disabled physics and controlled reconnects
to reduce resource usage.
</p>

</div>

</main>

</body>

</html>`
    );
  }
);

// ============================================================
// PROCESS ERRORS
// ============================================================

process.on(
  "uncaughtException",
  error => {

    const state =
      findState();

    if (
      state
    ) {

      rememberError(
        state,
        error
      );
    }

    log(
      `[PROCESS] Uncaught exception: ${
        error?.stack ||
        error?.message ||
        error
      }`
    );
  }
);

process.on(
  "unhandledRejection",
  reason => {

    const state =
      findState();

    if (
      state
    ) {

      rememberError(
        state,
        reason
      );
    }

    log(
      `[PROCESS] Unhandled rejection: ${
        reason instanceof Error
          ? (
              reason.stack ||
              reason.message
            )
          : String(
              reason
            )
      }`
    );
  }
);

// ============================================================
// HTTP SERVER
// ============================================================

const server =
  app.listen(
    PORT,
    "0.0.0.0",
    () => {

      log(
        `Dashboard listening on port ${PORT}.`
      );

      log(
        `[CONFIG] Found ${states.size} bot connection(s).`
      );

      let index =
        0;

      for (
        const state
        of states.values()
      ) {

        state.manualStop =
          false;

        const delay =
          START_STAGGER_MS *
          index++;

        const timer =
          setTimeout(
            () => {

              startBot(
                state
              ).catch(
                error => {

                  rememberError(
                    state,
                    error
                  );

                  scheduleReconnect(
                    state,
                    "initial startup failed"
                  );
                }
              );

            },
            delay
          );

        timer.unref?.();
      }
    }
  );

server.on(
  "error",
  error => {

    log(
      `[HTTP] Server error: ${
        error?.message ||
        error
      }`
    );
  }
);

// ============================================================
// SHUTDOWN
// ============================================================

let shuttingDown =
  false;

async function shutdown(
  signal
) {

  if (
    shuttingDown
  ) {
    return;
  }

  shuttingDown =
    true;

  log(
    `Received ${signal}; shutting down.`
  );

  for (
    const state
    of states.values()
  ) {

    try {

      await stopBot(
        state
      );

    } catch (_) {}
  }

  server.close(
    () => {
      process.exit(0);
    }
  );

  setTimeout(
    () => {
      process.exit(0);
    },
    5000
  ).unref();
}

// Wispbyte/hosted panels generally use SIGTERM
// for graceful shutdown. SIGINT is not trapped here.
process.once(
  "SIGTERM",
  () =>
    shutdown(
      "SIGTERM"
    )
);

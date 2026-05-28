module.exports = {
  apps: [{
    name: "urvar-bot",
    script: "bot.js",
    cwd: "/Users/dipankarchanda/Urvar/ai/urvar-ai-assistant/agents",
    restart_delay: 5000,
    max_restarts: 20,
    watch: false,
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    out_file: "/Users/dipankarchanda/Urvar/ai/urvar-ai-assistant/agents/logs/bot-out.log",
    error_file: "/Users/dipankarchanda/Urvar/ai/urvar-ai-assistant/agents/logs/bot-error.log",
  }]
};

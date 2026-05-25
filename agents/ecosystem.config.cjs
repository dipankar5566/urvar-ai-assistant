module.exports = {
  apps: [{
    name: "urvar-bot",
    script: "bot.js",
    cwd: "e:\\AI Assistant\\agents",
    restart_delay: 5000,
    max_restarts: 20,
    watch: false,
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    out_file: "e:\\AI Assistant\\logs\\bot-out.log",
    error_file: "e:\\AI Assistant\\logs\\bot-error.log",
  }]
};

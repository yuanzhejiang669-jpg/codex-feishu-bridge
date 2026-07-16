function buildInstallPlan(bots = []) {
  const activeBots = bots.filter((bot) => Number(bot.activeRunCount || 0) > 0);
  const onlineBots = bots.filter((bot) => bot.online === true);
  return {
    allowed: activeBots.length === 0,
    activeBots: activeBots.map((bot) => ({
      name: bot.name,
      activeRunCount: Number(bot.activeRunCount || 0),
    })),
    restartNames: onlineBots.map((bot) => bot.name),
  };
}

module.exports = { buildInstallPlan };

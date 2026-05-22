function jsonText(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  };
}

export async function readDiscordContext() {
  return jsonText({
    success: false,
    error: 'read_discord_context é executada pelo processo do Discord, não diretamente pelo servidor MCP.',
  });
}

export async function scheduleReminder() {
  return jsonText({
    success: false,
    error: 'schedule_reminder é executada pelo processo do Discord, não diretamente pelo servidor MCP.',
  });
}

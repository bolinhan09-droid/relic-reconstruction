/** Shell-owned settings, without credentials in node state or DOM events. */
export function requestAiSettings(section = 'assistant') {
  window.dispatchEvent(new CustomEvent('relic-open-ai-settings', {detail:{section}}));
}

export function publishAiSettings(section) {
  window.dispatchEvent(new CustomEvent('relic-ai-settings-changed', {detail:{section}}));
}

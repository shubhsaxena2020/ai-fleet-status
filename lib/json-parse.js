'use strict';

const JSON_BAD_CONTROL_CHARACTER_REGEX = /bad control character/i;

// Windows PowerShell 5.1's ConvertTo-Json has a documented history of emitting raw,
// unescaped control characters (0x00-0x1F) inside JSON string values instead of the
// \u00XX form the JSON spec requires. The PowerShell-side scrub in process-list.js
// removes control characters from CommandLine/Name before serialization to avoid this
// in the common case; this fallback exists for whatever slips through anyway (e.g. a
// PowerShell/host combination that behaves differently than the one this was tested on).
function parseJsonWithControlCharacterFallback(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (!JSON_BAD_CONTROL_CHARACTER_REGEX.test(error.message)) {
      throw error;
    }

    return JSON.parse(escapeRawControlCharactersInJsonStrings(text));
  }
}

function escapeRawControlCharactersInJsonStrings(text) {
  let result = '';
  let inString = false;
  let escaped = false;

  for (const char of text) {
    if (!inString) {
      result += char;

      if (char === '"') {
        inString = true;
      }

      continue;
    }

    if (escaped) {
      result += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      result += char;
      escaped = true;
      continue;
    }

    if (char === '"') {
      result += char;
      inString = false;
      continue;
    }

    const code = char.charCodeAt(0);

    if (code <= 0x1f) {
      result += `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }

    result += char;
  }

  return result;
}

module.exports = {
  parseJsonWithControlCharacterFallback,
  escapeRawControlCharactersInJsonStrings
};

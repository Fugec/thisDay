const MONTH_NUMBER = new Map([
  ["january", 1], ["february", 2], ["march", 3], ["april", 4],
  ["may", 5], ["june", 6], ["july", 7], ["august", 8],
  ["september", 9], ["october", 10], ["november", 11], ["december", 12],
]);

const MONTH_PATTERN =
  "January|February|March|April|May|June|July|August|September|October|November|December";

function calendarDateKey(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || y < 1 || !Number.isInteger(m) || m < 1 || m > 12 || !Number.isInteger(d) || d < 1 || d > 31) {
    return "";
  }
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function extractCalendarDateMentions(value) {
  const text = String(value || "");
  const mentions = [];
  const patterns = [
    {
      regex: new RegExp(`\\b(${MONTH_PATTERN})\\s+(\\d{1,2})(?:st|nd|rd|th)?[,]?\\s+(\\d{4})\\b`, "gi"),
      parts: (match) => [match[3], MONTH_NUMBER.get(match[1].toLowerCase()), match[2]],
    },
    {
      regex: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_PATTERN})[,]?\\s+(\\d{4})\\b`, "gi"),
      parts: (match) => [match[3], MONTH_NUMBER.get(match[2].toLowerCase()), match[1]],
    },
  ];
  for (const { regex, parts } of patterns) {
    for (const match of text.matchAll(regex)) {
      const [year, month, day] = parts(match);
      const key = calendarDateKey(year, month, day);
      if (!key) continue;
      mentions.push({ key, text: match[0], start: match.index, end: match.index + match[0].length });
    }
  }
  return mentions
    .sort((left, right) => left.start - right.start || right.end - left.end)
    .filter((mention, index, all) =>
      !all.slice(0, index).some(
        (prior) => mention.start >= prior.start && mention.end <= prior.end,
      ),
    );
}

export function calendarDateKeys(value) {
  return [...new Set(extractCalendarDateMentions(value).map((mention) => mention.key))];
}

function yearFromValue(value) {
  const match = String(value || "").match(/\b(\d{4})\b/);
  return match ? Number(match[1]) : 0;
}

function sourceLifeDateEvidence(entity) {
  const lead = String(entity?.intro || entity?.summary || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
  const leadSentence = lead.split(/(?<=[.!?])\s+/)[0] || lead;
  const dates = extractCalendarDateMentions(leadSentence);
  const parenthetical = leadSentence.match(/\(([^)]{4,180})\)/)?.[1] || "";
  const parentheticalDates = extractCalendarDateMentions(parenthetical);
  let birth = null;
  let death = null;

  if (/(?:\bborn\b|\bb\.)/i.test(parenthetical) && parentheticalDates[0]) {
    birth = parentheticalDates[0];
  } else if (parentheticalDates.length >= 2 && /[–—-]/.test(parenthetical)) {
    [birth, death] = parentheticalDates;
  } else if (/(?:\bborn\b|\bb\.)/i.test(leadSentence) && dates[0]) {
    birth = dates[0];
  }
  if (!death && /(?:\bdied\b|\bd\.)/i.test(parenthetical) && parentheticalDates.length) {
    death = parentheticalDates[parentheticalDates.length - 1];
  } else if (!death && /(?:\bdied\b|\bd\.)/i.test(leadSentence) && dates.length) {
    death = dates[dates.length - 1];
  }

  const description = String(entity?.description || "").trim();
  const yearRange = description.match(/\((\d{4})\s*[–—-]\s*(\d{4}|present)\)\s*$/i);
  const bornYear = description.match(/\(born\s+(\d{4})\)\s*$/i);
  return {
    birthKey: birth?.key || "",
    birthYear: birth ? Number(birth.key.slice(0, 4)) : Number(bornYear?.[1] || yearRange?.[1] || 0),
    deathKey: death?.key || "",
    deathYear: death ? Number(death.key.slice(0, 4)) : Number(yearRange?.[2] || 0),
  };
}

function dateConflicts(value, sourceKey, sourceYear) {
  const storedKey = calendarDateKeys(value)[0] || "";
  const storedYear = storedKey ? Number(storedKey.slice(0, 4)) : yearFromValue(value);
  if (!storedYear || !sourceYear) return false;
  if (storedYear !== sourceYear) return true;
  return Boolean(storedKey && sourceKey && storedKey !== sourceKey);
}

export function validatedPersonRenderDates(entity) {
  const evidence = sourceLifeDateEvidence(entity);
  const storedBirthDate = String(entity?.birthDate || "").trim();
  const storedDeathDate = String(entity?.deathDate || "").trim();
  const storedBirthKey = calendarDateKeys(storedBirthDate)[0] || "";
  const storedDeathKey = calendarDateKeys(storedDeathDate)[0] || "";
  const storedBirthYear = storedBirthKey
    ? Number(storedBirthKey.slice(0, 4))
    : yearFromValue(storedBirthDate);
  const storedDeathYear = storedDeathKey
    ? Number(storedDeathKey.slice(0, 4))
    : yearFromValue(storedDeathDate);
  const birthAfterDeath = Boolean(
    storedBirthYear &&
      storedDeathYear &&
      (storedBirthYear > storedDeathYear ||
        (storedBirthYear === storedDeathYear &&
          storedBirthKey &&
          storedDeathKey &&
          storedBirthKey > storedDeathKey)),
  );
  const birthConflict = birthAfterDeath || dateConflicts(
    entity?.birthDate,
    evidence.birthKey,
    evidence.birthYear,
  );
  const deathConflict = dateConflicts(
    entity?.deathDate,
    evidence.deathKey,
    evidence.deathYear,
  );
  return {
    birthDate: birthConflict ? "" : storedBirthDate,
    deathDate: deathConflict ? "" : storedDeathDate,
    birthConflict,
    deathConflict,
  };
}

export function stripPersonLifeDateParenthetical(value) {
  return String(value || "")
    .replace(/\s*\((?:born|died|b\.|d\.)\s+(?:[^()]|\([^)]*\)){1,80}\)\s*$/i, "")
    .replace(/\s*\(\d{4}\s*[–—-]\s*(?:\d{4}|present)\)\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

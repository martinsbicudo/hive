ObjC.import("Foundation");

function readInput() {
  const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  const raw = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
  const input = JSON.parse(raw);
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("the input must be a JSON object");
  return input;
}

function textOf(value) {
  return value === null || value === undefined ? "" : String(value);
}

const EVENT_LIMIT = 200;
const NOTES_LIMIT = 2000;
const RANGE_LIMIT_MS = 31 * 24 * 60 * 60 * 1000;

function isoOf(date) {
  return date ? date.toISOString() : "";
}

function run() {
  const input = readInput();
  const from = new Date(textOf(input.from));
  const to = new Date(textOf(input.to));
  const span = to.getTime() - from.getTime();
  if (Number.isNaN(span) || span <= 0 || span > RANGE_LIMIT_MS) throw new Error("the range must be valid and at most 31 days");
  const Calendar = Application("Calendar");
  const events = [];
  let truncated = false;
  for (const calendar of Calendar.calendars()) {
    const matching = calendar.events.whose({ _and: [{ startDate: { _lessThan: to } }, { endDate: { _greaterThan: from } }] });
    const titles = matching.summary();
    if (titles.length === 0) continue;
    const starts = matching.startDate();
    const ends = matching.endDate();
    const allDay = matching.alldayEvent();
    const locations = matching.location();
    const notes = matching.description();
    const name = textOf(calendar.name());
    for (let index = 0; index < titles.length; index += 1) {
      if (events.length >= EVENT_LIMIT) {
        truncated = true;
        break;
      }
      events.push({
        calendar: name,
        title: textOf(titles[index]),
        start: isoOf(starts[index]),
        end: isoOf(ends[index]),
        allDay: allDay[index] === true,
        location: textOf(locations[index]),
        notes: textOf(notes[index]).slice(0, NOTES_LIMIT),
      });
    }
  }
  events.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return JSON.stringify({ events, truncated });
}

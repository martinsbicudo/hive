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

function writableCalendar(Calendar, name) {
  if (name === undefined) {
    const first = Calendar.calendars().find((calendar) => calendar.writable());
    if (!first) throw new Error("there's no calendar Hive can write to");
    return first;
  }
  if (typeof name !== "string") throw new Error("calendar must be a name");
  const named = Calendar.calendars.whose({ name: name })();
  if (named.length === 0) throw new Error("there's no calendar with that name");
  if (!named[0].writable()) throw new Error("that calendar is read-only");
  return named[0];
}

function run() {
  const input = readInput();
  if (typeof input.title !== "string" || input.title.length === 0) throw new Error("title must be text");
  const start = new Date(textOf(input.start));
  const end = new Date(textOf(input.end));
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) throw new Error("start and end must be valid, with end after start");
  const Calendar = Application("Calendar");
  const calendar = writableCalendar(Calendar, input.calendar);
  const properties = { summary: input.title, startDate: start, endDate: end };
  if (typeof input.notes === "string" && input.notes.length > 0) properties.description = input.notes;
  calendar.events.push(Calendar.Event(properties));
  return JSON.stringify({ created: true, calendar: textOf(calendar.name()) });
}

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

function run() {
  const input = readInput();
  if (typeof input.to !== "string" || input.to.length === 0) throw new Error("to must be an address or phone number");
  if (typeof input.text !== "string" || input.text.length === 0) throw new Error("text must not be empty");
  const Messages = Application("Messages");
  const account = Messages.accounts.whose({ serviceType: "iMessage" })()[0];
  if (!account) throw new Error("Messages has no iMessage account");
  const known = account.participants.whose({ handle: input.to })();
  const participant = known.length > 0 ? known[0] : account.participants.byName(input.to);
  Messages.send(input.text, { to: participant });
  return JSON.stringify({ sent: true });
}

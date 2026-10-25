import { useState } from "react";
import { submitToken } from "../api.ts";

export function TokenField() {
  const [value, setValue] = useState("");
  return (
    <form
      className="empty token-field"
      onSubmit={(event) => {
        event.preventDefault();
        submitToken(value);
      }}
    >
      <h2>Open the board from the Hive menu</h2>
      <p className="muted">
        This tab isn't connected to Hive. To use it anyway, paste the token from <code>~/.hive/token</code>. It's kept in this tab only.
      </p>
      <input type="password" autoComplete="off" spellCheck={false} aria-label="Hive token" placeholder="Token" value={value} onChange={(event) => setValue(event.target.value)} />
      <button className="primary" type="submit" disabled={!value.trim()}>Connect</button>
    </form>
  );
}

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StartupSplash } from "./startup-splash.js";

describe("StartupSplash", () => {
  it("announces startup while the session catalog loads", () => {
    const output = renderToStaticMarkup(<StartupSplash ready={false} />);

    expect(output).toContain('data-state="loading"');
    expect(output).toContain('role="status"');
    expect(output).toContain('src="/icon.svg"');
    expect(output).toContain("Connecting to your host");
  });

  it("stays visible on the first render even when startup is already ready", () => {
    const output = renderToStaticMarkup(<StartupSplash ready />);

    expect(output).toContain(
      '<div class="startup-splash" data-state="loading" role="status" aria-live="polite">',
    );
  });
});

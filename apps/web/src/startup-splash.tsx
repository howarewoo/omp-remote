import { useEffect, useState } from "react";

const MINIMUM_SPLASH_DURATION_MS = 600;
const MAXIMUM_SPLASH_DURATION_MS = 5_000;

interface StartupSplashProps {
  ready: boolean;
}

export function StartupSplash({ ready }: StartupSplashProps) {
  const [minimumDurationElapsed, setMinimumDurationElapsed] = useState(false);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    const minimumTimer = window.setTimeout(() => setMinimumDurationElapsed(true), MINIMUM_SPLASH_DURATION_MS);
    const maximumTimer = window.setTimeout(() => setHidden(true), MAXIMUM_SPLASH_DURATION_MS);
    return () => {
      window.clearTimeout(minimumTimer);
      window.clearTimeout(maximumTimer);
    };
  }, []);

  useEffect(() => {
    if (ready && minimumDurationElapsed) setHidden(true);
  }, [minimumDurationElapsed, ready]);

  return (
    <div
      className="startup-splash"
      data-state={hidden ? "ready" : "loading"}
      role={hidden ? undefined : "status"}
      aria-hidden={hidden || undefined}
      aria-live={hidden ? undefined : "polite"}
    >
      <div className="startup-splash-content">
        <div className="startup-mark-stage" aria-hidden="true">
          <img className="startup-mark startup-mark-base" src="/icon.svg" alt="" />
          <span className="startup-mark-reveal">
            <img className="startup-mark" src="/icon.svg" alt="" />
          </span>
          <span className="startup-mark-scan" />
        </div>

        <div className="startup-brand">
          <strong>omp</strong>
          <span>remote</span>
        </div>

        <p className="startup-status">
          <span className="startup-status-signal" aria-hidden="true" />
          Connecting to your host
        </p>
      </div>
    </div>
  );
}

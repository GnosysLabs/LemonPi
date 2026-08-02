import lemonPiLogo from "../../assets/piwm.png";

export function StartupSplash({ exiting = false }: { exiting?: boolean }) {
  return (
    <div
      className={`startup-splash${exiting ? " startup-splash--exiting" : ""}`}
      role="status"
      aria-live="polite"
      aria-label="Loading LemonPi"
      aria-busy={!exiting}
    >
      <img className="startup-splash__logo" src={lemonPiLogo} alt="" />
    </div>
  );
}

import { clsx } from "clsx";
import piwmLogo from "../../assets/piwm.png";

export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className={clsx("brand", compact && "brand--compact")}>
      <img className="brand__mark" src={piwmLogo} alt="Pi" />
    </div>
  );
}

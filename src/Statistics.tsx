import { useState } from "react";
import Reports from "./Reports";
import ItemReport from "./ItemReport";
import "./Statistics.css";

export default function Statistics() {
  const [tab, setTab] = useState<"trade" | "item">("trade");

  return (
    <div className="statistics">
      <div className="stat-sub-tabs">
        <button className={tab === "trade" ? "active" : ""} onClick={() => setTab("trade")}>
          Trade Report
        </button>
        <button className={tab === "item" ? "active" : ""} onClick={() => setTab("item")}>
          Item Report
        </button>
      </div>
      {tab === "trade" ? <Reports /> : <ItemReport />}
    </div>
  );
}

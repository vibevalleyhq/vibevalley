/** @jsxImportSource @solidjs/web */
import Home from "./components/Home";
import NotFound from "./components/NotFound";
import { page } from "./lib/page";

import "./styles/global.css";

export default function App() {
  const route = page();
  return route.lost ? <NotFound /> : <Home copy={route.copy} />;
}

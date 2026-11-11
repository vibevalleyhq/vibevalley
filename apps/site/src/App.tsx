import { page } from "./i18n/page";
/** @jsxImportSource @solidjs/web */
import Home from "./sections/Home";
import NotFound from "./sections/NotFound";

import "./ui/global.css";

export default function App() {
  const route = page();
  return route.lost ? <NotFound /> : <Home copy={route.copy} />;
}

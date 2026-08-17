import { BrowserRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Landing } from "./pages/Landing";
import { SpacePage } from "./pages/SpacePage";
import { SessionPage } from "./pages/SessionPage";

const queryClient = new QueryClient();

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/s/:slug" element={<SpacePage />} />
          <Route path="/session/:id" element={<SessionPage />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import AuthPage from "@/pages/Auth";
import DashboardPage from "@/pages/Dashboard";
import SettingsPage from "@/pages/Settings";
import KeysPage from "@/pages/Keys";
import PaymentsPage from "@/pages/Payments";
import CustomersPage from "@/pages/Customers";
import Layout from "@/components/Layout";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
});

function isAuthed(): boolean {
  return !!localStorage.getItem("platform_token");
}

function ProtectedRoute({ component: Component }: { component: React.ComponentType }) {
  if (!isAuthed()) return <Redirect to="/login" />;
  return <Layout><Component /></Layout>;
}

function Router() {
  return (
    <Switch>
      <Route path="/login" component={AuthPage} />
      <Route path="/register" component={AuthPage} />
      <Route path="/" component={() => isAuthed() ? <Redirect to="/dashboard" /> : <Redirect to="/login" />} />
      <Route path="/dashboard" component={() => <ProtectedRoute component={DashboardPage} />} />
      <Route path="/settings" component={() => <ProtectedRoute component={SettingsPage} />} />
      <Route path="/keys" component={() => <ProtectedRoute component={KeysPage} />} />
      <Route path="/payments" component={() => <ProtectedRoute component={PaymentsPage} />} />
      <Route path="/customers" component={() => <ProtectedRoute component={CustomersPage} />} />
      <Route component={() => <Redirect to="/dashboard" />} />
    </Switch>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
        <Router />
      </WouterRouter>
    </QueryClientProvider>
  );
}

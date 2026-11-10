import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import {
	NavLink,
	Navigate,
	Outlet,
	RouterProvider,
	createHashRouter,
	useLocation,
	useRouteError,
} from "react-router-dom";
import { Alert, NoticesProvider } from "../components/ui";
import "../styles/app.css";
import "../styles/react.css";

const Cases = lazy(() =>
	import("../features/catalog/page").then((m) => ({ default: m.CasesPage })),
);
const Case = lazy(() =>
	import("../features/case-editor/page").then((m) => ({ default: m.CasePage })),
);
const Imports = lazy(() =>
	import("../features/imports/page").then((m) => ({ default: m.ImportsPage })),
);
const Runs = lazy(() =>
	import("../features/runs/page").then((m) => ({ default: m.RunsPage })),
);
const NewRun = lazy(() =>
	import("../features/runs/new").then((m) => ({ default: m.NewRunPage })),
);
const Run = lazy(() =>
	import("../features/runs/detail").then((m) => ({ default: m.RunPage })),
);
const Verifiers = lazy(() =>
	import("../features/verifiers/page").then((m) => ({
		default: m.VerifiersPage,
	})),
);
const Settings = lazy(() =>
	import("../features/settings/page").then((m) => ({
		default: m.SettingsPage,
	})),
);

function Layout() {
	const route = useLocation();
	const active = route.pathname.startsWith("/run")
		? "runs"
		: route.pathname.startsWith("/verifiers")
			? "verifiers"
			: route.pathname.startsWith("/settings")
				? "settings"
				: "cases";
	return (
		<NoticesProvider>
			<a className="SkipLink" href="#app">
				跳转到主要内容
			</a>
			<header className="AppHeader">
				<div className="AppHeader-inner">
					<NavLink className="AppHeader-brand" to="/cases">
						<span>
							Cline <span className="brand-slash">/</span>{" "}
							<strong>Agent Eval</strong>
						</span>
					</NavLink>
					<nav className="AppHeader-nav" aria-label="主导航">
						{[
							["cases", "案例集"],
							["runs", "评测批次"],
							["verifiers", "验证脚本"],
							["settings", "运行配置"],
						].map(([key, label]) => (
							<NavLink
								key={key}
								to={`/${key}`}
								className={active === key ? "active" : ""}
								aria-current={active === key ? "page" : undefined}
							>
								{label}
							</NavLink>
						))}
					</nav>
				</div>
			</header>
			<main id="app" className="AppMain" tabIndex={-1}>
				<Suspense fallback={<output className="empty">加载中…</output>}>
					<Outlet />
				</Suspense>
			</main>
		</NoticesProvider>
	);
}
function RouteError() {
	const error = useRouteError();
	return (
		<main className="AppMain">
			<Alert>{error instanceof Error ? error.message : "页面加载失败"}</Alert>
			<button
				type="button"
				className="btn"
				onClick={() => {
					location.hash = "/cases";
					location.reload();
				}}
			>
				重新加载
			</button>
		</main>
	);
}
const router = createHashRouter([
	{
		element: <Layout />,
		errorElement: <RouteError />,
		children: [
			{ index: true, element: <Navigate to="/cases" replace /> },
			{ path: "cases/:moduleId?", element: <Cases /> },
			{ path: "case/new", element: <Case /> },
			{ path: "case/:id", element: <Case /> },
			{ path: "import", element: <Imports /> },
			{ path: "runs", element: <Runs /> },
			{ path: "run/new", element: <NewRun /> },
			{ path: "run/:id", element: <Run /> },
			{ path: "verifiers", element: <Verifiers /> },
			{ path: "settings", element: <Settings /> },
			{ path: "*", element: <Navigate to="/cases" replace /> },
		],
	},
]);
const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			staleTime: 10000,
			retry: (count, error: any) =>
				error?.status >= 400 && error?.status < 500 ? false : count < 1,
			refetchOnWindowFocus: false,
		},
		mutations: { retry: false },
	},
});
queryClient.setQueryDefaults(["trial-state"], { gcTime: Infinity });
createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={queryClient}>
		<RouterProvider router={router} />
	</QueryClientProvider>,
);

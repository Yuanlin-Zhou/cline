import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App, ConfigProvider, Menu, Skeleton } from "antd";
import zhCN from "antd/locale/zh_CN";
import { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import {
	createHashRouter,
	Navigate,
	NavLink,
	Outlet,
	RouterProvider,
	useLocation,
	useRouteError,
} from "react-router-dom";
import { Alert, Button, NoticesProvider } from "../components/ui";
import "../styles/app.css";
import "../styles/react.css";
import "../styles/antd.css";

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

const Scorers = lazy(() =>
	import("../features/scorers/page").then((m) => ({ default: m.ScorersPage })),
);
function Layout() {
	const route = useLocation();
	const active = route.pathname.startsWith("/scorers")
		? "scorers"
		: route.pathname.startsWith("/run")
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
							DevAgent <span className="brand-slash">/</span>{" "}
							<strong>Agent Eval</strong>
						</span>
					</NavLink>
					<Menu
						className="eval-navigation"
						mode="horizontal"
						selectedKeys={[active]}
						items={[
							["cases", "案例集"],
							["runs", "评测批次"],
							["verifiers", "验证脚本"],
							["scorers", "LLM 评分器"],
							["settings", "运行配置"],
						].map(([key, label]) => ({
							key,
							label: <NavLink to={`/${key}`}>{label}</NavLink>,
						}))}
					/>
				</div>
			</header>
			<main id="app" className="AppMain" tabIndex={-1}>
				<Suspense fallback={<Skeleton active />}>
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
			<Button
				type="button"
				className="btn"
				onClick={() => {
					location.hash = "/cases";
					location.reload();
				}}
			>
				重新加载
			</Button>
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
			{ path: "scorers", element: <Scorers /> },
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
	<ConfigProvider
		wave={{ disabled: true }}
		button={{ autoInsertSpace: false }}
		locale={zhCN}
		theme={{
			token: { colorPrimary: "#1677ff", borderRadius: 8, fontSize: 14 },
			components: { Card: { headerFontSize: 16 } },
		}}
	>
		<App>
			<QueryClientProvider client={queryClient}>
				<RouterProvider router={router} />
			</QueryClientProvider>
		</App>
	</ConfigProvider>,
);

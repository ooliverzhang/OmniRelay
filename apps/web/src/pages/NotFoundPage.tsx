import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-center">
      <p className="text-5xl font-bold text-slate-700">404</p>
      <h1 className="text-lg font-semibold text-slate-200">页面不存在</h1>
      <p className="max-w-sm text-sm text-slate-500">
        你访问的路径没有对应的页面，可能已被移除或输入有误。
      </p>
      <Link
        to="/dashboard"
        className="mt-2 inline-flex h-9 items-center rounded-lg bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-500"
      >
        返回仪表盘
      </Link>
    </div>
  );
}

import { Link, useLocation } from "react-router-dom";

const links = [
  { to: "/", label: "Explore" },
  { to: "/create", label: "Create lock" },
];

export function VestingNav() {
  const { pathname } = useLocation();

  return (
    <nav className="vesting-nav">
      <Link to="/" className="vesting-nav__brand">
        GitHub Vesting
      </Link>
      <div className="vesting-nav__links">
        {links.map(({ to, label }) => (
          <Link
            key={to}
            to={to}
            className={pathname === to || (to !== "/" && pathname.startsWith(to)) ? "active" : ""}
          >
            {label}
          </Link>
        ))}
      </div>
    </nav>
  );
}

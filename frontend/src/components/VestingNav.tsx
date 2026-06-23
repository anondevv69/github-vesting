import { Link, useLocation } from "react-router-dom";

const links = [
  { to: "/vesting/explore", label: "Explore" },
  { to: "/vesting/dashboard", label: "My locks" },
  { to: "/vesting/setup", label: "Create lock" },
];

export function VestingNav() {
  const { pathname } = useLocation();

  return (
    <nav className="vesting-nav">
      <Link to="/vesting/explore" className="vesting-nav__brand">
        GitHub Vesting
      </Link>
      <div className="vesting-nav__links">
        {links.map(({ to, label }) => (
          <Link
            key={to}
            to={to}
            className={pathname === to || pathname.startsWith(`${to}/`) ? "active" : ""}
          >
            {label}
          </Link>
        ))}
      </div>
    </nav>
  );
}

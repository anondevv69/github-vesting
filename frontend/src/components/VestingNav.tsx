import { Link, useLocation } from "react-router-dom";

const links = [
  { to: "/vesting/dashboard", label: "My locks" },
  { to: "/vesting/explore", label: "Explore" },
  { to: "/vesting/setup", label: "New vesting" },
];

export function VestingNav() {
  const { pathname } = useLocation();

  return (
    <nav className="vesting-nav">
      <Link to="/vesting/dashboard" className="vesting-nav__brand">
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
      <style>{`
        .vesting-nav {
          display: flex;
          align-items: center;
          gap: 1.5rem;
          padding: 0.75rem 1rem;
          border-bottom: 1px solid #e5e7eb;
          margin-bottom: 1.5rem;
          flex-wrap: wrap;
        }
        .vesting-nav__brand {
          font-weight: 700;
          color: #111827;
          text-decoration: none;
        }
        .vesting-nav__links {
          display: flex;
          gap: 1rem;
          flex-wrap: wrap;
        }
        .vesting-nav__links a {
          color: #6b7280;
          text-decoration: none;
          font-size: 0.9rem;
        }
        .vesting-nav__links a.active {
          color: #7c3aed;
          font-weight: 600;
        }
      `}</style>
    </nav>
  );
}

import { LayoutDashboard, User, Shield } from 'lucide-react';

const BASE_TABS = [
  { id: 'dashboard', label: 'Dashboard', Icon: LayoutDashboard },
  { id: 'account',   label: 'Account',   Icon: User },
];

export default function AppNav({ activeTab, onTabChange, isAdmin }) {
  const tabs = isAdmin
    ? [...BASE_TABS, { id: 'admin', label: 'Admin', Icon: Shield }]
    : BASE_TABS;

  return (
    <div
      className="border-b flex items-center px-4 gap-1"
      style={{ background: '#0d0d17', borderColor: 'rgba(255,255,255,0.06)', height: '44px' }}
    >
      {tabs.map(({ id, label, Icon }) => {
        const active = activeTab === id;
        return (
          <button
            key={id}
            onClick={() => onTabChange(id)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
            style={{
              background: active ? 'rgba(99,102,241,0.15)' : 'transparent',
              color:      active ? '#818cf8' : '#475569',
              border:     active ? '1px solid rgba(99,102,241,0.25)' : '1px solid transparent',
            }}
          >
            <Icon size={13} />
            {label}
          </button>
        );
      })}
    </div>
  );
}

/** ui — a simple tab bar (buttons with role="tab"). */
export interface TabItem<T extends string> {
  id: T;
  label: string;
  testId?: string;
  badge?: string | number | undefined;
}

export interface TabsProps<T extends string> {
  tabs: TabItem<T>[];
  active: T;
  onChange: (id: T) => void;
  className?: string;
}

export function Tabs<T extends string>({ tabs, active, onChange, className }: TabsProps<T>) {
  return (
    <div className={className ? `tabs ${className}` : 'tabs'} role="tablist">
      {tabs.map(tab => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === active}
          className={tab.id === active ? 'tab tab-active' : 'tab'}
          data-testid={tab.testId}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
          {tab.badge !== undefined && tab.badge !== '' && tab.badge !== 0 && <span className="tab-badge">{tab.badge}</span>}
        </button>
      ))}
    </div>
  );
}

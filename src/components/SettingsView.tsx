import React, { useEffect, useState } from 'react';
import { Bot, Brain, Database, SlidersHorizontal } from 'lucide-react';
import { useTranslation } from '../hooks/useTranslation';
import { useAppStore } from '../store';
import type { SettingsTabId } from '../types';
import AgentsTab from './settings/AgentsTab';
import AiSettingsTab from './settings/AiSettingsTab';
import DataSourceTab from './settings/DataSourceTab';
import SystemTab from './settings/SystemTab';
import { PageHeader, TabPanel, Tabs } from './ui';

type TabId = SettingsTabId;

const ID_BASE = 'settings';

/** One tab per settings page; feedback goes through the shared toast. */
const SettingsView: React.FC = () => {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<TabId>('data');
  // Tabs stay mounted once opened, so an unsaved draft survives a look at another tab.
  const [opened, setOpened] = useState<ReadonlySet<TabId>>(() => new Set<TabId>(['data']));
  const selectTab = (id: TabId) => {
    setActiveTab(id);
    setOpened((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  };

  const tabRequest = useAppStore((s) => s.settingsTabRequest);
  const consumeTabRequest = useAppStore((s) => s.consumeSettingsTabRequest);
  useEffect(() => {
    if (!tabRequest) return;
    setActiveTab(tabRequest);
    setOpened((prev) => (prev.has(tabRequest) ? prev : new Set(prev).add(tabRequest)));
    consumeTabRequest();
  }, [tabRequest, consumeTabRequest]);

  const tabs = [
    { id: 'ai' as const, label: t.settings.tabs.ai, icon: Brain },
    { id: 'data' as const, label: t.settings.tabs.data, icon: Database },
    { id: 'agents' as const, label: t.settings.tabs.agents, icon: Bot },
    { id: 'advanced' as const, label: t.settings.tabs.advanced, icon: SlidersHorizontal },
  ];

  return (
    <div className="mx-auto max-w-4xl pb-24">
      <PageHeader title={t.settings.title} description={t.settings.subtitle} />
      <Tabs
        label={t.settings.title}
        idBase={ID_BASE}
        items={tabs}
        value={activeTab}
        onChange={selectTab}
        className="mb-6"
      />
      {tabs
        .filter((tab) => opened.has(tab.id))
        .map((tab) => (
          <div key={tab.id} hidden={tab.id !== activeTab}>
            <TabPanel idBase={ID_BASE} id={tab.id}>
              {tab.id === 'ai' && <AiSettingsTab />}
              {tab.id === 'data' && <DataSourceTab />}
              {tab.id === 'agents' && <AgentsTab />}
              {tab.id === 'advanced' && <SystemTab active={activeTab === 'advanced'} />}
            </TabPanel>
          </div>
        ))}
    </div>
  );
};

export default SettingsView;

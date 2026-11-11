import { Download, Keyboard, Upload } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';

import { AccountField } from '@/components/account-field';
import { AdvancedFold } from '@/components/advanced-fold';
import { SelectMenu } from '@/components/select-menu';
import { SessionSettingsFields } from '@/components/session-settings-fields';
import { SettingsField } from '@/components/settings-field';
import { SettingsSection } from '@/components/settings-section';
import { ShortcutKeyChips } from '@/components/shortcut-key-chips';
import { StorageMeter } from '@/components/storage-meter';
import { Button } from '@/components/ui/button';
import { DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { YoutubeAccessField } from '@/components/youtube-access-field';
import { useSessionSettings } from '@/hooks/use-session-settings';
import { useErrorToast } from '@/hooks/use-toast';
import type { SettingsFocus } from '@/lib/app-route';
import { isCloudSyncEnabled } from '@/lib/cloud-config';
import { type CommandRow, commandRows, commandsFailed, commandsLoading } from '@/lib/command-rows';
import { canExportAll } from '@/lib/export-actions';
import { appliedUiLanguage, t } from '@/lib/i18n';
import { openShortcutSettings } from '@/lib/open-shortcut-settings';
import { isMacPlatform } from '@/lib/shortcut-keys';
import {
  DEFAULT_SORT_SETTINGS,
  duplicateTabOptions,
  groupFromOptions,
  groupingModeOptions,
  isDuplicateTabHandling,
  isGroupFrom,
  isGroupingMode,
  isSortBy,
  parseSortSettings,
  sortByHintKey,
  sortByOptions,
  SORT_SETTING_KEYS,
  showsCustomSortOptions,
} from '@/lib/sort-settings';
import {
  isUiLanguage,
  languageSaveFailedMessage,
  saveUiLanguage,
  type UiLanguage,
  uiLanguageOptions,
} from '@/lib/ui-language';
import type { SessionSettings, SessionSummary, SortSettings } from '@/types';

/** Chrome names keys differently on a Mac (Option, Command), so the page asks once. */
const IS_MAC = isMacPlatform(navigator.userAgent);

interface SettingsPageProps {
  summaries: SessionSummary[];
  onNotice(message: string): void;
  /** A setting was written; the app shows the confirmation toast. */
  onSaved(message: string): void;
  /** A setting could not be written - shown in the app's error line, which stays up. */
  onError(message: string): void;
  onExportAll(): void;
  onImport(): void;
  exporting: boolean;
  /** The part to bring into view on arrival (`#settings/youtube`), if the address names one. */
  focus?: SettingsFocus;
  /** The page's error lines, shown at the top of the scrolling body. */
  children?: ReactNode;
}

/**
 * Everything configurable, in one place inside the app: Chrome's own "Options" entry opens this
 * very view (`app.html#settings`). It is the content of the Settings dialog in `app.tsx` - a
 * fixed title row over a scrolling body - so it must be rendered inside a `DialogContent`. Sort by and Duplicate tabs are visible because they change what a
 * click on the icon visibly does, with the three Custom-only choices indented under Sort by while
 * Custom is chosen; the other two sit under "Advanced". YouTube (access for "Pause all YouTube
 * videos") follows Sorting, since the right-click menu item sends people here. Nothing has a Save button
 * - a setting is written the moment it changes, as it already was for the session settings.
 */
export function SettingsPage({
  summaries,
  onNotice,
  onSaved,
  onError,
  onExportAll,
  onImport,
  exporting,
  focus,
  children,
}: SettingsPageProps) {
  const [sort, setSort] = useState<SortSettings>(DEFAULT_SORT_SETTINGS);
  // `null` until Chrome answers; `'failed'` when it does not.
  const [commands, setCommands] = useState<CommandRow[] | null | 'failed'>(null);
  // The language the page is actually in (index.tsx put it in use before the first render), not a
  // fresh read of storage: right from the first frame, and 'auto' when the chosen one failed to load.
  const [language, setLanguage] = useState<UiLanguage>(appliedUiLanguage);
  const sessionSettings = useSessionSettings();
  useErrorToast(sessionSettings.error);

  useEffect(() => {
    chrome.storage.sync.get<Partial<SortSettings>>([...SORT_SETTING_KEYS], (result) => {
      setSort(parseSortSettings(result));
    });
    // The real keys, read from Chrome rather than promised by this page: they are unbound until
    // the user assigns them at chrome://extensions/shortcuts.
    chrome.commands.getAll().then(
      (all) => setCommands(commandRows(all, IS_MAC)),
      () => setCommands('failed'),
    );
  }, []);

  /**
   * Writes one changed key straight through and confirms it. One wording, "Setting saved", for both
   * halves of this page: sort settings live in `chrome.storage.sync` and session settings in
   * `chrome.storage.local`, but that split is not something to explain in a toast. The confirmation is raised in the
   * storage callback, not beside the `setSort` above it: the control moves optimistically so it
   * never feels laggy, but "Saved" must mean the write actually landed.
   */
  const write = (patch: Partial<SortSettings>) => {
    const next = { ...sort, ...patch };
    setSort(next);
    chrome.storage.sync.set(next, () => {
      if (chrome.runtime.lastError !== undefined) {
        onError(
          t('settingsSaveFailed', chrome.runtime.lastError.message ?? t('settingsUnknownError')),
        );
        return;
      }
      onSaved(t('settingsSaved'));
    });
  };

  /**
   * The language menu. Every string on the page, and every number and date format, was made in
   * the language in use when the page loaded, so once the choice is stored the page reloads into
   * it; the address keeps `#settings`, so the dialog comes back. A refused write keeps the page
   * as it is and says why.
   */
  const changeLanguage = (value: string) => {
    if (!isUiLanguage(value) || value === language) {
      return;
    }
    const previous = language;
    setLanguage(value);
    saveUiLanguage(value).then(
      () => location.reload(),
      (err: unknown) => {
        console.error('[tabinet] language not saved', err);
        setLanguage(previous);
        onError(languageSaveFailedMessage(err));
      },
    );
  };

  /** The session half. `update()` reports failure through its result; it never throws. */
  const writeSession = (patch: Partial<SessionSettings>) => {
    void sessionSettings.update(patch).then((ok) => {
      if (ok) {
        onSaved(t('settingsSaved'));
      }
    });
  };

  const showCustomOptions = showsCustomSortOptions(sort.sortBy);

  return (
    <>
      {/* The language menu sits on the title row, left of the × (DialogCloseButton, placed absolutely
          at top-4 right-4 by app.tsx): pr-14 keeps the row clear of it, and on a narrow window the
          menu wraps under the title instead of running into it. */}
      <DialogHeader className="flex-row flex-wrap items-start justify-between gap-x-4 gap-y-3 border-b py-4 pr-14 pl-6 text-left">
        <div className="flex min-w-0 flex-col gap-2">
          <DialogTitle>{t('settingsTitle')}</DialogTitle>
          <DialogDescription className="text-xs">{t('settingsSubtitle')}</DialogDescription>
        </div>
        <SelectMenu
          label={t('settingsLanguage')}
          title={t('settingsLanguageTitle')}
          value={language}
          options={uiLanguageOptions()}
          onValueChange={changeLanguage}
        />
      </DialogHeader>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto bg-muted/30 px-6 py-4">
        {children}

        <SettingsSection
          title={t('settingsSortingTitle')}
          description={t('settingsSortingDescription')}
        >
          <SettingsField
            label={t('settingsSortBy')}
            hint={t(sortByHintKey(sort.sortBy))}
            htmlFor="sort-by"
          >
            <SelectMenu
              id="sort-by"
              title={t('settingsSortByTitle')}
              value={sort.sortBy}
              options={sortByOptions()}
              onValueChange={(value) => {
                if (isSortBy(value)) {
                  write({ sortBy: value });
                }
              }}
            />
          </SettingsField>

          {/* Only "Custom" reads these (showsCustomSortOptions), so they sit under "Sort by",
              indented, while it is chosen, and are not shown at all otherwise. */}
          {showCustomOptions && (
            <div className="space-y-5 border-l-2 border-border pl-4">
              <SettingsField
                label={t('settingsTabGroups')}
                hint={t('settingsTabGroupsHint')}
                htmlFor="grouping-mode"
              >
                <SelectMenu
                  id="grouping-mode"
                  value={sort.groupingMode}
                  options={groupingModeOptions()}
                  onValueChange={(value) => {
                    if (isGroupingMode(value)) {
                      write({ groupingMode: value });
                    }
                  }}
                />
              </SettingsField>

              <SettingsField
                label={t('settingsGroupingDirection')}
                hint={t('settingsGroupingDirectionHint')}
                htmlFor="group-from"
              >
                <SelectMenu
                  id="group-from"
                  value={sort.groupFrom}
                  options={groupFromOptions()}
                  onValueChange={(value) => {
                    if (isGroupFrom(value)) {
                      write({ groupFrom: value });
                    }
                  }}
                />
              </SettingsField>

              <SettingsField
                label={t('settingsPreserveOrder')}
                hint={t('settingsPreserveOrderHint')}
                htmlFor="preserve-order"
              >
                <Switch
                  id="preserve-order"
                  checked={sort.preserveOrderWithinGroups}
                  onCheckedChange={(checked) => write({ preserveOrderWithinGroups: checked })}
                />
              </SettingsField>
            </div>
          )}

          <SettingsField
            label={t('settingsDuplicateTabs')}
            hint={t('settingsDuplicateTabsHint')}
            htmlFor="duplicate-tabs"
          >
            <SelectMenu
              id="duplicate-tabs"
              value={sort.duplicateTabHandling}
              options={duplicateTabOptions()}
              onValueChange={(value) => {
                if (isDuplicateTabHandling(value)) {
                  write({ duplicateTabHandling: value });
                }
              }}
            />
          </SettingsField>

          <AdvancedFold
            label={t('settingsAdvanced')}
            description={t('settingsSortingAdvancedDescription')}
          >
            <SettingsField
              label={t('settingsSortPinned')}
              htmlFor="sort-pinned"
              hint={t('settingsSortPinnedHint')}
            >
              <Switch
                id="sort-pinned"
                checked={sort.sortPinnedTabs}
                onCheckedChange={(checked) => write({ sortPinnedTabs: checked })}
              />
            </SettingsField>

            <SettingsField
              label={t('settingsGroupSuspended')}
              htmlFor="group-suspended"
              hint={t('settingsGroupSuspendedHint')}
            >
              <Switch
                id="group-suspended"
                checked={sort.groupSuspendedTabs}
                onCheckedChange={(checked) => write({ groupSuspendedTabs: checked })}
              />
            </SettingsField>
          </AdvancedFold>
        </SettingsSection>

        {/* Its own small section, not under Advanced: the access is needed before the menu item and
            the shortcut do anything, and the menu item opens this dialog to ask for it. */}
        <SettingsSection
          title={t('settingsYoutubeTitle')}
          description={t('settingsYoutubeDescription', t('cmdPauseYoutube'))}
        >
          <YoutubeAccessField
            sentHere={focus === 'youtube'}
            onSaved={onSaved}
            onNotice={onNotice}
            onError={onError}
          />
        </SettingsSection>

        {/* Cloud sync sign-in. Absent while CLOUD_SYNC (src/constants.ts) is empty, so a build
            without a sync server shows exactly what it did before. */}
        {isCloudSyncEnabled() && (
          <SettingsSection
            title={t('settingsAccountTitle')}
            description={t('settingsAccountDescription')}
          >
            <AccountField onNotice={onNotice} onError={onError} />
          </SettingsSection>
        )}

        <SettingsSection
          title={t('settingsSessionsTitle')}
          description={t('settingsSessionsDescription')}
        >
          <SessionSettingsFields
            settings={sessionSettings.settings}
            disabled={sessionSettings.loading}
            onChange={writeSession}
            subset="basic"
            idPrefix="settings-sessions"
          />
          <AdvancedFold
            label={t('settingsAdvanced')}
            description={t('settingsSessionsAdvancedDescription')}
          >
            <SessionSettingsFields
              settings={sessionSettings.settings}
              disabled={sessionSettings.loading}
              onChange={writeSession}
              subset="advanced"
              idPrefix="settings-sessions-advanced"
            />
          </AdvancedFold>
        </SettingsSection>

        <SettingsSection
          title={t('settingsBackupTitle')}
          description={t(
            isCloudSyncEnabled() ? 'settingsBackupDescriptionSynced' : 'settingsBackupDescription',
          )}
        >
          <SettingsField
            label={t('settingsExportEverything')}
            hint={t('settingsExportEverythingHint')}
          >
            <Button
              variant="outline"
              size="sm"
              onClick={onExportAll}
              disabled={exporting || !canExportAll(summaries)}
            >
              <Download />
              {t('settingsExportButton')}
            </Button>
          </SettingsField>
          <SettingsField label={t('settingsImport')} hint={t('settingsImportHint')}>
            <Button variant="outline" size="sm" onClick={onImport}>
              <Upload />
              {t('settingsImportButton')}
            </Button>
          </SettingsField>
          <AdvancedFold
            label={t('settingsAdvanced')}
            description={t('settingsBackupAdvancedDescription')}
          >
            <StorageMeter summaries={summaries} onNotice={onNotice} />
          </AdvancedFold>
        </SettingsSection>

        <SettingsSection
          title={t('settingsShortcutsTitle')}
          description={t('settingsShortcutsDescription')}
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => void openShortcutSettings()}
              title={t('settingsChangeInChromeTitle')}
            >
              <Keyboard />
              {t('settingsChangeInChrome')}
            </Button>
          }
        >
          {commands === null && (
            <p className="text-xs text-muted-foreground">{commandsLoading()}</p>
          )}
          {commands === 'failed' && (
            <p className="text-xs text-muted-foreground">{commandsFailed()}</p>
          )}
          {Array.isArray(commands) &&
            commands.map((command) => (
              <SettingsField key={command.id} label={command.name} hint={command.hint}>
                <ShortcutKeyChips keys={command.keys} />
              </SettingsField>
            ))}
        </SettingsSection>
      </div>
    </>
  );
}

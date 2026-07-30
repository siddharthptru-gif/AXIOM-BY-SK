import { useEffect, useRef, useState } from 'react';
import { onNotification } from '../notifications/bus';
import { announcementForNotification, shouldAnnounce } from '../../../common/a11y';
import { subscribeAnnounce } from '../a11y/announcer';

/**
 * Screen-reader live region (PRD Phases 253/254). Two visually-hidden `aria-live`
 * regions — polite (info + explicit announcements) and assertive (warnings/errors) —
 * fed by the notification bus and the explicit announce bus. Exact repeats are
 * suppressed (per politeness) so a screen reader isn't spammed. Purely additive:
 * sighted UI (toasts, panels) is unchanged.
 */
export function LiveRegion() {
  const [polite, setPolite] = useState('');
  const [assertive, setAssertive] = useState('');
  const lastPolite = useRef<string>('');
  const lastAssertive = useRef<string>('');

  useEffect(() => {
    const emit = (text: string, politeness: 'polite' | 'assertive'): void => {
      if (politeness === 'assertive') {
        if (!shouldAnnounce(lastAssertive.current, text)) return;
        lastAssertive.current = text;
        setAssertive(text);
      } else {
        if (!shouldAnnounce(lastPolite.current, text)) return;
        lastPolite.current = text;
        setPolite(text);
      }
    };

    const offNotify = onNotification((n) => {
      const a = announcementForNotification(n.level, n.message, n.detail, n.source);
      emit(a.text, a.politeness);
    });
    const offAnnounce = subscribeAnnounce((a) => emit(a.text, a.politeness));
    return () => {
      offNotify();
      offAnnounce();
    };
  }, []);

  return (
    <>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {polite}
      </div>
      <div className="sr-only" role="alert" aria-live="assertive" aria-atomic="true">
        {assertive}
      </div>
    </>
  );
}

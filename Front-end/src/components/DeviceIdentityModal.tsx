import { useState, type FormEvent } from 'react';
import { assertNoInjectionChars, uuidSchema } from '../security/validators';

interface DeviceIdentityModalProps {
  deviceId: string | null;
  isSubmitting: boolean;
  onClose: () => void;
  onRecoverDevice: (uuid: string) => Promise<void>;
  onResetNewDevice: () => Promise<void>;
}

export function DeviceIdentityModal({
  deviceId,
  isSubmitting,
  onClose,
  onRecoverDevice,
  onResetNewDevice,
}: DeviceIdentityModalProps) {
  const [inputUuid, setInputUuid] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!deviceId) {
      return;
    }
    try {
      await navigator.clipboard.writeText(deviceId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard API might be unavailable
    }
  };

  const handleRecoverSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    try {
      assertNoInjectionChars(inputUuid, 'deviceId');
    } catch {
      setError('Caracteres no permitidos en el identificador de dispositivo');
      return;
    }

    const parsed = uuidSchema.safeParse(inputUuid);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'UUID inválido');
      return;
    }

    await onRecoverDevice(parsed.data);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="device-title"
    >
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-edge bg-surface p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 id="device-title" className="text-lg font-bold text-heading">
            Identidad anónima (deviceId)
          </h2>
          <button
            type="button"
            className="cursor-pointer rounded-lg px-3 py-1.5 text-xs font-semibold text-ink hover:bg-elevated"
            onClick={onClose}
          >
            Cerrar
          </button>
        </div>

        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">
            Tu progreso, preferencias y sesiones están vinculados a este UUID anónimo validado en
            servidor.
          </p>

          <div className="flex items-center justify-between gap-3 overflow-x-auto rounded-lg border border-edge bg-canvas px-3.5 py-2.5">
            <code className="font-mono text-xs text-heading">{deviceId ?? 'Sin asignar'}</code>
            {deviceId && (
              <button
                type="button"
                className="shrink-0 cursor-pointer rounded-lg border border-edge bg-elevated px-3 py-1 text-xs font-semibold text-heading hover:border-brand"
                onClick={handleCopy}
              >
                {copied ? 'Copiado' : 'Copiar'}
              </button>
            )}
          </div>

          <form className="flex flex-col gap-3.5" onSubmit={handleRecoverSubmit} noValidate>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="recover-device-uuid" className="text-xs font-semibold text-heading">
                Recuperar cuenta con otro deviceId (UUID estricto)
              </label>
              <input
                id="recover-device-uuid"
                type="text"
                value={inputUuid}
                onChange={(e) => {
                  setInputUuid(e.target.value);
                  setError(null);
                }}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                className="w-full rounded-lg border border-edge bg-canvas px-3 py-2 font-mono text-xs text-heading"
                autoComplete="off"
                spellCheck={false}
              />
            </div>

            {error && (
              <p
                className="rounded-xl border border-danger bg-danger-bg px-3.5 py-2 text-xs font-medium text-danger"
                role="alert"
              >
                {error}
              </p>
            )}

            <div className="flex flex-wrap justify-end gap-2.5 pt-1">
              <button
                type="button"
                className="cursor-pointer rounded-xl px-4 py-2 text-sm font-semibold text-ink hover:bg-elevated disabled:opacity-55"
                onClick={() => void onResetNewDevice()}
                disabled={isSubmitting}
              >
                Generar nuevo dispositivo
              </button>
              <button
                type="submit"
                className="cursor-pointer rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-brand-ink hover:bg-brand-hover disabled:opacity-55"
                disabled={isSubmitting}
              >
                {isSubmitting ? 'Validando...' : 'Recuperar UUID'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

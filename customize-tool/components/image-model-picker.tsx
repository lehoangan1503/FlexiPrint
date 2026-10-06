"use client";

/**
 * Home page: the image model the whole team's AI pictures are made with (server/settings.ts). Changing it applies
 * to the next run everywhere — studio clipart / đa sắc / vật liệu / sửa, ảnh tổ hợp, @flexiprint's runs.
 */

import { useEffect, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { ctApi } from "../lib/api-client";
import { CT_DEFAULT_IMAGE_MODEL, CT_IMAGE_MODELS, type CtImageModel } from "../lib/image-models";
import { CtSelect, CtTooltip } from "./ui";

export function ImageModelPicker() {
  const [model, setModel] = useState<string>(CT_DEFAULT_IMAGE_MODEL);
  const [models, setModels] = useState<readonly CtImageModel[]>(CT_IMAGE_MODELS);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    ctApi
      .imageModel()
      .then((r) => {
        setModel(r.model);
        setModels(r.models);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const pick = (next: string) => {
    const prev = model;
    setModel(next);
    setSaving(true);
    setError(null);
    ctApi
      .setImageModel(next)
      .then((r) => setModel(r.model))
      .catch((e: Error) => {
        setModel(prev);
        setError(e.message);
      })
      .finally(() => setSaving(false));
  };

  const note = models.find((m) => m.id === model)?.note ?? "";
  return (
    <CtTooltip label={error ?? `Model tạo ảnh AI cho cả team — ${note}`}>
      <div className="flex items-center gap-1.5">
        {saving ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : <Sparkles className="h-4 w-4 text-muted-foreground" />}
        <CtSelect<string>
          className="h-9 w-48"
          value={model}
          onChange={pick}
          disabled={saving}
          options={models.map((m) => ({ value: m.id, label: m.label }))}
        />
      </div>
    </CtTooltip>
  );
}

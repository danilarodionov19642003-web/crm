from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    KeepTogether,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)


ROOT = Path("/Users/mentori/mentori-crm")
OUT_DIR = ROOT / "reports/direct-client-report"
OUT = OUT_DIR / "Отчет_Яндекс_Директ_Спектр_Металла_11-20_августа_2026.pdf"

RED = colors.HexColor("#C82020")
DARK = colors.HexColor("#17191F")
CHARCOAL = colors.HexColor("#292C33")
MID = colors.HexColor("#626773")
LIGHT = colors.HexColor("#F3F4F6")
PALE_RED = colors.HexColor("#FBEAEA")
PALE_GREEN = colors.HexColor("#EAF5EF")
GREEN = colors.HexColor("#2E7D50")
WHITE = colors.white
LINE = colors.HexColor("#D9DCE2")


def register_fonts():
    regular_candidates = [
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    bold_candidates = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ]
    regular = next(Path(p) for p in regular_candidates if Path(p).exists())
    bold = next(Path(p) for p in bold_candidates if Path(p).exists())
    pdfmetrics.registerFont(TTFont("ReportRegular", str(regular)))
    pdfmetrics.registerFont(TTFont("ReportBold", str(bold)))


register_fonts()


styles = getSampleStyleSheet()
BODY = ParagraphStyle(
    "Body",
    parent=styles["BodyText"],
    fontName="ReportRegular",
    fontSize=9.2,
    leading=12.1,
    textColor=DARK,
    spaceAfter=5,
)
SMALL = ParagraphStyle(
    "Small",
    parent=BODY,
    fontSize=8.0,
    leading=10.2,
    textColor=MID,
)
H1 = ParagraphStyle(
    "H1",
    parent=BODY,
    fontName="ReportBold",
    fontSize=19,
    leading=22,
    textColor=RED,
    spaceAfter=8,
)
H2 = ParagraphStyle(
    "H2",
    parent=BODY,
    fontName="ReportBold",
    fontSize=13.2,
    leading=16,
    textColor=DARK,
    spaceBefore=7,
    spaceAfter=5,
)
H3 = ParagraphStyle(
    "H3",
    parent=BODY,
    fontName="ReportBold",
    fontSize=10.5,
    leading=13,
    textColor=CHARCOAL,
    spaceBefore=4,
    spaceAfter=4,
)
WHITE_SMALL = ParagraphStyle(
    "WhiteSmall",
    parent=SMALL,
    textColor=WHITE,
    alignment=TA_CENTER,
)
WHITE_BIG = ParagraphStyle(
    "WhiteBig",
    parent=BODY,
    fontName="ReportBold",
    fontSize=17,
    leading=19,
    textColor=WHITE,
    alignment=TA_CENTER,
)
TABLE_HEAD = ParagraphStyle(
    "TableHead",
    parent=SMALL,
    fontName="ReportBold",
    textColor=WHITE,
    alignment=TA_LEFT,
)
TABLE_TEXT = ParagraphStyle(
    "TableText",
    parent=SMALL,
    textColor=DARK,
)
TABLE_NUM = ParagraphStyle(
    "TableNum",
    parent=SMALL,
    textColor=DARK,
    alignment=TA_CENTER,
)


def p(text, style=BODY):
    return Paragraph(text, style)


def bullet(text):
    return Paragraph("<font color='#C82020'>■</font>&nbsp;&nbsp;" + text, BODY)


def section_title(number, title):
    return p(f"{number}. {title}", H1)


def callout(label, text, fill=LIGHT, accent=RED):
    data = [[p(label, ParagraphStyle("CallLabel", parent=BODY, fontName="ReportBold", textColor=accent)), p(text, BODY)]]
    table = Table(data, colWidths=[32 * mm, 140 * mm], hAlign="LEFT")
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), fill),
        ("BOX", (0, 0), (-1, -1), 0.5, fill),
        ("LINEBEFORE", (0, 0), (0, -1), 4, accent),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]))
    return table


def metric_strip(items):
    cells = []
    for value, label in items:
        cells.append([p(value, WHITE_BIG), p(label, WHITE_SMALL)])
    table = Table([cells], colWidths=[43 * mm] * len(items), hAlign="LEFT")
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), DARK),
        ("BOX", (0, 0), (-1, -1), 0.5, DARK),
        ("INNERGRID", (0, 0), (-1, -1), 0.5, CHARCOAL),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 9),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 9),
    ]))
    return table


def data_table(rows, widths, numeric_cols=(), font_size=7.7):
    rendered = []
    for r_idx, row in enumerate(rows):
        rendered_row = []
        for c_idx, value in enumerate(row):
            if r_idx == 0:
                rendered_row.append(p(str(value), TABLE_HEAD))
            else:
                style = TABLE_NUM if c_idx in numeric_cols else TABLE_TEXT
                local = ParagraphStyle(f"Cell{r_idx}_{c_idx}", parent=style, fontSize=font_size, leading=font_size + 2.1)
                rendered_row.append(p(str(value), local))
        rendered.append(rendered_row)
    table = Table(rendered, colWidths=widths, repeatRows=1, hAlign="LEFT")
    commands = [
        ("BACKGROUND", (0, 0), (-1, 0), DARK),
        ("TEXTCOLOR", (0, 0), (-1, 0), WHITE),
        ("GRID", (0, 0), (-1, -1), 0.45, LINE),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]
    for row in range(1, len(rows)):
        if row % 2:
            commands.append(("BACKGROUND", (0, row), (-1, row), LIGHT))
    commands.append(("BACKGROUND", (0, len(rows) - 1), (-1, len(rows) - 1), colors.HexColor("#E8E9EC")))
    table.setStyle(TableStyle(commands))
    return table


def page_header_footer(canvas, doc):
    canvas.saveState()
    width, height = A4
    canvas.setStrokeColor(LINE)
    canvas.setLineWidth(0.5)
    canvas.line(20 * mm, height - 13 * mm, width - 20 * mm, height - 13 * mm)
    canvas.setFont("ReportBold", 7.2)
    canvas.setFillColor(MID)
    canvas.drawRightString(width - 20 * mm, height - 9.5 * mm, "СПЕКТР МЕТАЛЛА  |  ЯНДЕКС.ДИРЕКТ  |  MENTORI")
    canvas.line(20 * mm, 13 * mm, width - 20 * mm, 13 * mm)
    canvas.setFont("ReportRegular", 7.1)
    canvas.drawString(20 * mm, 8.5 * mm, "Отчёт за 11-20 августа 2026  |  metallomsk.ru  |  mentori.tech")
    canvas.drawRightString(width - 20 * mm, 8.5 * mm, f"Страница {doc.page}")
    canvas.restoreState()


def build_story():
    story = []

    # Page 1
    story += [
        Spacer(1, 8 * mm),
        p("СПЕКТР МЕТАЛЛА", ParagraphStyle("Brand", parent=BODY, fontName="ReportBold", textColor=RED, fontSize=10, spaceAfter=18)),
        p("Результаты рекламы<br/>и следующий этап", ParagraphStyle("Cover", parent=BODY, fontName="ReportBold", fontSize=27, leading=30, textColor=DARK, spaceAfter=7)),
        p("Профнастил и металлочерепица  |  Омск и Омская область", ParagraphStyle("Sub", parent=BODY, fontName="ReportBold", fontSize=11.8, textColor=MID)),
        p("Отчёт за 11-20 августа 2026 года", ParagraphStyle("Period", parent=BODY, fontSize=9.5, textColor=MID)),
        p("Подготовлено MENTORI  |  mentori.tech", ParagraphStyle("Author", parent=BODY, fontName="ReportBold", fontSize=9.2, textColor=RED, spaceAfter=17)),
        metric_strip([
            ("3 837", "показов"),
            ("369", "переходов"),
            ("11 516 руб.", "расход с НДС"),
            ("11", "контактных действий"),
        ]),
        Spacer(1, 8 * mm),
        p("Главный вывод", H2),
        callout("Результат", "Кампании продолжают приводить целевой спрос. Профнастил даёт основной объём и 9 из 11 отслеживаемых действий. Металлочерепица привлекает меньше трафика, но подтверждает отдельный интерес к модели Супер-Монтеррей.", PALE_GREEN, GREEN),
        Spacer(1, 3 * mm),
        bullet("Средняя стоимость перехода - 31,21 руб. при установленном ориентире 70 руб."),
        bullet("Зафиксировано 10 кликов по телефону и 1 переход в WhatsApp."),
        bullet("CTR 9,62% показывает, что объявления сохраняют хорошую релевантность поисковому спросу."),
        bullet("Формы и корзина за период не зафиксированы: основной способ связи посетителей - телефон."),
        bullet("19 августа выполнена дополнительная очистка запросов; эффект оценивается в следующем периоде."),
        Spacer(1, 3 * mm),
        callout("Важно", "Контактное действие не равно подтверждённой продаже. Для оценки окупаемости менеджеру необходимо отмечать состоявшиеся звонки, сообщения, расчёты и заказы.", PALE_RED, RED),
    ]

    # Page 2
    story += [
        PageBreak(),
        section_title(1, "Результаты рекламных кампаний"),
        p("Все суммы приведены с учётом НДС. Кампании работают только в поиске Яндекса по Омску и Омской области."),
        data_table([
            ["Кампания", "Показы", "Переходы", "CTR", "CPC", "Расход", "Действия"],
            ["Профнастил", "3 121", "297", "9,52%", "26,33 руб.", "7 819,43 руб.", "9"],
            ["Металлочерепица", "716", "72", "10,06%", "51,35 руб.", "3 696,93 руб.", "2"],
            ["Итого", "3 837", "369", "9,62%", "31,21 руб.", "11 516,36 руб.", "11"],
        ], [43 * mm, 20 * mm, 23 * mm, 18 * mm, 22 * mm, 28 * mm, 22 * mm], numeric_cols=(1, 2, 3, 4, 5, 6), font_size=7.5),
        Spacer(1, 5 * mm),
        p("Что показывают цифры", H2),
        bullet("Профнастил остаётся основным направлением: 80,5% всех переходов и 81,8% контактных действий."),
        bullet("Металлочерепица показывает более высокий CTR, но её переход почти вдвое дороже: 51,35 руб. против 26,33 руб."),
        bullet("Ориентировочная стоимость контактного действия: 868,83 руб. по профнастилу и 1 848,47 руб. по металлочерепице."),
        bullet("Общая стоимость контактного действия - 1 046,94 руб. Это промежуточный показатель, пока звонки не сопоставлены с реальными заказами."),
        Spacer(1, 4 * mm),
        callout("Решение", "Профнастил сохраняет приоритет бюджета. Металлочерепицу продолжаем точечно, усиливая только объявления и запросы, которые уже дали контактные действия.", PALE_GREEN, GREEN),
        Spacer(1, 5 * mm),
        p("Отслеживаемые действия", H2),
        data_table([
            ["Действие", "Профнастил", "Металлочерепица", "Итого"],
            ["Клик по телефону", "8", "2", "10"],
            ["Переход в WhatsApp", "1", "0", "1"],
            ["Форма или корзина", "0", "0", "0"],
            ["Всего", "9", "2", "11"],
        ], [72 * mm, 34 * mm, 38 * mm, 30 * mm], numeric_cols=(1, 2, 3), font_size=8.0),
    ]

    # Page 3
    story += [
        PageBreak(),
        section_title(2, "Какие объявления работают лучше"),
        p("Сравниваем не только кликабельность, но и стоимость контактного действия. Небольшие выборки отмечены отдельно и требуют дальнейшего подтверждения."),
        data_table([
            ["Группа объявлений", "Переходы", "Расход", "Действия", "Цена действия"],
            ["Профнастил: купить и цена", "70", "2 373,96 руб.", "4", "593,49 руб."],
            ["Профнастил: цвета и размеры", "97", "2 857,41 руб.", "3", "952,47 руб."],
            ["Профнастил: для крыши", "73", "1 685,86 руб.", "2", "842,93 руб."],
            ["Профнастил: для забора", "51", "799,81 руб.", "0", "-"],
            ["Металлочерепица: Супер-Монтеррей", "9", "328,62 руб.", "1", "328,62 руб.*"],
            ["Металлочерепица: купить и цена", "32", "2 027,00 руб.", "1", "2 027,00 руб."],
            ["Металлочерепица: крыша и кровля", "31", "1 341,30 руб.", "0", "-"],
        ], [70 * mm, 23 * mm, 32 * mm, 24 * mm, 31 * mm], numeric_cols=(1, 2, 3, 4), font_size=7.2),
        p("* У Супер-Монтеррей пока только 9 переходов. Результат сильный, но выборка ещё мала для резкого увеличения бюджета.", SMALL),
        p("Подтверждённые сильные связки", H2),
        bullet("«Купить и цена» по профнастилу - 4 действия и лучшая подтверждённая стоимость среди групп с достаточным объёмом."),
        bullet("«Цвета и размеры» - самый большой объём переходов и 3 контактных действия."),
        bullet("«Для крыши» по профнастилу улучшилось до 2 действий за период."),
        bullet("Супер-Монтеррей дал действие по запросу «супер монтеррей купить омск» и требует отдельного аккуратного теста."),
        p("Что требует корректировки", H2),
        bullet("Группа профнастила «для забора» дала 51 переход без контактов. В тексте нужно чётче обозначить продажу материала без монтажа, если монтаж не выполняется."),
        bullet("Группа металлочерепицы «для крыши и кровли» использовала 1 341,30 руб. без действий. Её следует переписать и ограничить до получения нового результата."),
        callout("Следующий тест", "Добавить отдельные объявления под С8, Велюр, RAL 8017, матовый профнастил и Супер-Монтеррей. Эти формулировки уже встречаются в запросах с контактными действиями.", PALE_RED, RED),
    ]

    # Page 4
    story += [
        PageBreak(),
        section_title(3, "Поисковые запросы и очистка трафика"),
        callout("Выполнено 19 августа", "Списки минус-фраз расширены до 101 фразы для профнастила и 99 для металлочерепицы. Исключены другие города, конкуренты и неподходящие товары. Минус-фразы Н60 и Н75 удалены, чтобы не блокировать потенциальный спрос на несущие профили.", PALE_GREEN, GREEN),
        Spacer(1, 4 * mm),
        p("Запросы, которые дали контактные действия", H2),
        data_table([
            ["Направление", "Примеры запросов"],
            ["Профнастил: покупка", "купить профлист в Омске; профнастил Омск купить; профлист купить Омск"],
            ["Профнастил: покрытие", "профнастил матовый Омск; профлист С8 8017 Велюр; серый профлист С8"],
            ["Профнастил: крыша", "профлист 4 метра для крыши; профлисты для крыши по оптовой цене"],
            ["Расчёт", "калькулятор профнастила на стену"],
            ["Металлочерепица", "Супер-Монтеррей купить Омск; металлочерепица в Омске"],
        ], [48 * mm, 126 * mm], font_size=7.7),
        Spacer(1, 5 * mm),
        p("Что было добавлено в исключения", H2),
        data_table([
            ["Категория", "Примеры"],
            ["Другие регионы", "Орск, Томск, Сургут, Грозный, Ростов-на-Дону, Новосибирск, Санкт-Петербург"],
            ["Магазины и конкуренты", "Лемана ПРО, Леруа Мерлен, варианты ошибочного написания"],
            ["Неподходящие товары", "калитка, уголок, ендова, распил, некондиция, плоское кровельное железо"],
            ["Пересечение кампаний", "евроштакетник и металлический штакетник исключены из металлочерепицы"],
        ], [49 * mm, 125 * mm], font_size=7.7),
        Spacer(1, 5 * mm),
        callout("Контроль", "Новые минус-фразы внесены в конце отчётного периода. Их влияние на снижение нецелевого расхода корректно оценивать по следующему полному периоду.", LIGHT, MID),
    ]

    # Page 5
    story += [
        PageBreak(),
        section_title(4, "Дополнительная возможность роста: SEO"),
        callout("Отдельная услуга", "SEO-продвижение не входит в текущее ведение Директа. Реклама уже собрала реальные формулировки покупателей, на основе которых можно создать страницы и статьи и постепенно получать часть трафика без оплаты каждого клика.", PALE_RED, RED),
        Spacer(1, 4 * mm),
        p("Темы подтверждены реальными запросами", H2),
        data_table([
            ["Тема", "Что спрашивают", "Что создать"],
            ["Цена и размеры", "цена за лист, длина 4-6 м, рабочая ширина", "Страницы цен и размеров"],
            ["Расчёт материала", "сколько листов нужно, вес, площадь, калькулятор", "Калькулятор и инструкция"],
            ["Выбор профиля", "С8, С21, НС44, Н60, назначение профилей", "Гид по профилям"],
            ["Крыша и забор", "что выбрать, как рассчитать, какой профиль использовать", "Посадочные страницы по задаче"],
            ["Цвета и покрытия", "RAL 8017, графит, матовый, Велюр", "Страницы цветов и покрытий"],
            ["Металлочерепица", "Монтеррей, Супер-Монтеррей, размеры и толщина", "Гид и отдельные товарные страницы"],
        ], [38 * mm, 67 * mm, 69 * mm], font_size=7.2),
        Spacer(1, 5 * mm),
        p("Экономический смысл", H2),
        bullet("Информационные запросы редко дают заявку с первого перехода, но сейчас каждый такой переход оплачивается в Директе."),
        bullet("SEO-страницы работают в долгую: отвечают на вопрос покупателя, приводят бесплатный поисковый трафик и усиливают доверие к компании."),
        bullet("Первыми стоит запускать темы с коммерческим продолжением: цены, размеры, расчёт, профили для крыши и забора, покрытия и Супер-Монтеррей."),
        callout("Предложение", "Отдельный SEO-этап: семантика, структура посадочных страниц, 4-6 приоритетных материалов, техническая оптимизация, перелинковка и контроль индексации.", PALE_GREEN, GREEN),
    ]

    # Page 6
    story += [
        PageBreak(),
        section_title(5, "Поведение посетителей и скорость сайта"),
        p("Метрика зафиксировала поведение всех посетителей и отдельно рекламного трафика. Данные не семплированы."),
        data_table([
            ["Сегмент", "Визиты", "Пользователи", "Просмотры", "Отказы", "Время"],
            ["Реклама Яндекса", "308", "239", "418", "23,1%", "48 сек."],
            ["Весь сайт", "364", "280", "532", "22,8%", "56 сек."],
        ], [48 * mm, 24 * mm, 28 * mm, 26 * mm, 24 * mm, 24 * mm], numeric_cols=(1, 2, 3, 4, 5), font_size=7.6),
        Spacer(1, 5 * mm),
        p("Что это означает", H2),
        bullet("Рекламные посетители просматривают в среднем 1,36 страницы за визит. Большинство принимает решение внутри одной товарной страницы."),
        bullet("Среднее время рекламного визита - 48 секунд. Первое впечатление и скорость переключения каталога напрямую влияют на оплаченный трафик."),
        bullet("Показатель отказов 23,1% не является аварийным, но оставляет резерв для повышения глубины просмотра и количества обращений."),
        Spacer(1, 4 * mm),
        callout("Почему отдельный этап", "При создании сайта приоритетом были каталог, цены, мобильная версия, корзина, формы и аналитика. После накопления реального рекламного трафика стало видно, какие именно переходы и сценарии нужно ускорить. Это не исправление неработающего сайта, а отдельная модернизация под масштабирование рекламы.", LIGHT, MID),
        p("Что входит в ускорение", H2),
        bullet("Быстрое переключение товарных категорий без повторной загрузки тяжёлых данных."),
        bullet("Оптимизация шрифтов, анимаций, фильтров и работы старых iPhone/Safari."),
        bullet("Сохранение отдельных адресов страниц для Директа и SEO."),
        bullet("Замеры до и после, проверка на компьютерах и мобильных устройствах."),
        callout("Результат для бизнеса", "Меньше ожидания между разделами и ниже риск потерять посетителя, за переход которого уже заплачено.", PALE_GREEN, GREEN),
    ]

    # Page 7
    story += [
        PageBreak(),
        section_title(6, "План следующего этапа"),
        p("Тестовый этап завершён. Дальнейшая работа строится на фактических действиях и качестве обращений, а не только на количестве переходов."),
        data_table([
            ["Приоритет", "Действие", "Как проверяем"],
            ["1. Профнастил", "Сохраняем основной бюджет и усиливаем «купить и цена», «цвета и размеры», «для крыши»", "Стоимость реального обращения"],
            ["2. Супер-Монтеррей", "Запускаем отдельный ограниченный тест по модели и коммерческим запросам", "Не менее 20-30 переходов"],
            ["3. Слабые группы", "Переписываем «для забора» и металлочерепицу «для крыши»", "Контакты после нового текста"],
            ["4. Запросы", "Еженедельно проверяем поисковые фразы и расширяем исключения", "Доля нецелевого расхода"],
            ["5. Аналитика продаж", "Сверяем клики по телефону и WhatsApp с реальными диалогами", "Заказы, расчёты, выручка"],
        ], [37 * mm, 87 * mm, 50 * mm], font_size=7.4),
        Spacer(1, 5 * mm),
        callout("Текущие настройки", "Поиск Яндекса, Омск и Омская область, ежедневный показ 08:00-21:00 по Омску. Недельные лимиты: 5 000 руб. на профнастил и 2 000 руб. на металлочерепицу. Рекламная сеть отключена.", LIGHT, MID),
        Spacer(1, 5 * mm),
        p("Итог", H2),
        callout("Следующий шаг", "Спрос подтверждён, рабочие направления определены, нецелевые запросы дополнительно очищены. Теперь задача - повысить долю реальных обращений и заказов, сохраняя контроль бюджета.", PALE_GREEN, GREEN),
        Spacer(1, 12 * mm),
        p("Отчёт подготовлен MENTORI  |  mentori.tech", ParagraphStyle("Sign", parent=BODY, fontName="ReportBold", fontSize=10, textColor=RED, alignment=TA_CENTER)),
    ]

    return story


def build():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    doc = BaseDocTemplate(
        str(OUT),
        pagesize=A4,
        leftMargin=20 * mm,
        rightMargin=20 * mm,
        topMargin=18 * mm,
        bottomMargin=18 * mm,
        title="Отчёт Яндекс.Директ - Спектр Металла - 11-20 августа 2026",
        author="MENTORI",
        subject="Результаты рекламных кампаний и план следующего этапа",
    )
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="main")
    doc.addPageTemplates(PageTemplate(id="report", frames=[frame], onPage=page_header_footer))
    doc.build(build_story())
    print(OUT)


if __name__ == "__main__":
    build()

import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { env } from '../config/env.js';
import { initModels } from '../config/init.js';
import { GameCategory, type CategoryConfiguration, type RegistrationField } from '../modules/categories/category.model.js';
import { Registration, type RegistrationStatus } from '../modules/registrations/registration.model.js';
import { Setting } from '../modules/settings/setting.model.js';
import { Tournament } from '../modules/tournaments/tournament.model.js';
import { User } from '../modules/users/user.model.js';
import { hashPassword } from '../modules/auth/auth.service.js';

const DAY = 86400000;
const now = Date.now();
const date = (offsetDays: number, hour = 10) => {
  const value = new Date(now + offsetDays * DAY);
  value.setHours(hour, 0, 0, 0);
  return value;
};

const chessTypes = [
  { value: 'classical', label: { ka: 'კლასიკური', en: 'Classical', ru: 'Классические' } },
  { value: 'rapid', label: { ka: 'რაპიდი', en: 'Rapid', ru: 'Рапид' } },
  { value: 'blitz', label: { ka: 'ბლიცი', en: 'Blitz', ru: 'Блиц' } },
  { value: 'bullet', label: { ka: 'ბულეტი', en: 'Bullet', ru: 'Пуля' } },
  { value: 'chess960', label: { ka: 'ჭადრაკი 960', en: 'Chess960', ru: 'Шахматы 960' } },
];

const formats = [
  { value: 'swiss', label: { ka: 'შვეიცარიული სისტემა', en: 'Swiss System', ru: 'Швейцарская система' } },
  { value: 'round_robin', label: { ka: 'რაუნდ-რობინი', en: 'Round Robin', ru: 'Круговая система' } },
  { value: 'knockout', label: { ka: 'ოლიმპიური სისტემა', en: 'Knockout', ru: 'Олимпийская система' } },
];

const registrationFields: RegistrationField[] = [
  { key: 'firstName', label: { ka: 'სახელი', en: 'First name', ru: 'Имя' }, type: 'text', required: true, enabled: true },
  { key: 'lastName', label: { ka: 'გვარი', en: 'Last name', ru: 'Фамилия' }, type: 'text', required: true, enabled: true },
  { key: 'email', label: { ka: 'ელფოსტა', en: 'Email', ru: 'Эл. почта' }, type: 'email', required: true, enabled: true },
  { key: 'phone', label: { ka: 'ტელეფონი', en: 'Phone', ru: 'Телефон' }, type: 'tel', required: true, enabled: true },
  { key: 'fideId', label: { ka: 'FIDE ID', en: 'FIDE ID', ru: 'FIDE ID' }, type: 'text', required: false, enabled: true },
  { key: 'rating', label: { ka: 'რეიტინგი', en: 'Rating', ru: 'Рейтинг' }, type: 'number', required: false, enabled: true },
  { key: 'club', label: { ka: 'კლუბი / ორგანიზაცია', en: 'Club / organization', ru: 'Клуб / организация' }, type: 'text', required: false, enabled: true },
  { key: 'notes', label: { ka: 'დამატებითი ინფორმაცია', en: 'Additional notes', ru: 'Дополнительная информация' }, type: 'textarea', required: false, enabled: true },
];

const demoParticipants = [
  { firstName: 'ლუკა', lastName: 'ბერიძე', email: 'luka.beridze@example.ge', phone: '+995555100001', rating: 2140, club: 'თბილისის ჭადრაკის აკადემია' },
  { firstName: 'ანა', lastName: 'ქავთარაძე', email: 'ana.kavtaradze@example.ge', phone: '+995555100002', rating: 1985, club: 'დინამო' },
  { firstName: 'გიორგი', lastName: 'მელაძე', email: 'giorgi.meladze@example.ge', phone: '+995555100003', rating: 2210, club: 'ბათუმის საჭადრაკო კლუბი' },
  { firstName: 'ნინო', lastName: 'ჩხეიძე', email: 'nino.chkheidze@example.ge', phone: '+995555100004', rating: 1870, club: 'თბილისის ჭადრაკის აკადემია' },
  { firstName: 'დავით', lastName: 'ჯაფარიძე', email: 'davit.japharidze@example.ge', phone: '+995555100005', rating: 2045, club: 'საბურთალო' },
  { firstName: 'მარიამ', lastName: 'გოცირიძე', email: 'mariam.gotsiridze@example.ge', phone: '+995555100006', rating: 1930, club: 'ქუთაისი' },
  { firstName: 'სანდრო', lastName: 'ცხადაძე', email: 'sandro.tskhadadze@example.ge', phone: '+995555100007', rating: 1760, club: 'გორი' },
  { firstName: 'თამარ', lastName: 'ხატიაშვილი', email: 'tamar.khatiashvili@example.ge', phone: '+995555100008', rating: 1845, club: 'დინამო' },
  { firstName: 'ილია', lastName: 'სულაბერიძე', email: 'ilia.sulaberidze@example.ge', phone: '+995555100009', rating: 2090, club: 'თბილისის ჭადრაკის აკადემია' },
  { firstName: 'ელენე', lastName: 'მღებრიშვილი', email: 'elene.mghebrishvili@example.ge', phone: '+995555100010', rating: 1720, club: 'რუსთავი' },
  { firstName: 'ნიკა', lastName: 'ყიფიანი', email: 'nika.qipiani@example.ge', phone: '+995555100011', rating: 1660, club: 'ზუგდიდი' },
  { firstName: 'სალომე', lastName: 'დოლიძე', email: 'salome.dolidze@example.ge', phone: '+995555100012', rating: 1810, club: 'ქუთაისი' },
];

async function ensureUser(input: {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  role: 'super_admin' | 'admin' | 'participant';
}) {
  const existing = await User.findOne({ email: input.email });
  if (existing) {
    return existing;
  }
  return User.create({
    firstName: input.firstName,
    lastName: input.lastName,
    email: input.email,
    role: input.role,
    passwordHash: await hashPassword(input.password),
    preferredLanguage: 'ka',
  });
}

async function ensureChessCategory() {
  const existing = await GameCategory.findOne({ slug: 'chess' });
  if (existing) {
    return existing;
  }
  const configuration: CategoryConfiguration = {
    tournamentTypes: chessTypes,
    formats,
    features: { timeControl: true, rounds: true, rating: true, fideId: true, club: true },
    defaults: { rounds: 9 },
  };
  return GameCategory.create({
    name: { ka: 'ჭადრაკი', en: 'Chess', ru: 'Шахматы' },
    slug: 'chess',
    description: {
      ka: 'კლასიკური, სწრაფი და ბლიც ჭადრაკის ტურნირები საქართველოს მასშტაბით.',
      en: 'Classical, rapid and blitz chess tournaments across Georgia.',
      ru: 'Классические, быстрые и блиц-турниры по шахматам по всей Грузии.',
    },
    icon: 'pi pi-crown',
    image: { url: '/images/categories/chess.jpg', publicId: '' },
    isActive: true,
    displayOrder: 1,
    configuration,
    registrationFields,
  });
}

interface SeedTournament {
  slug: string;
  title: { ka: string; en: string; ru: string };
  description: { ka: string; en: string; ru: string };
  tournamentType: string;
  format: string;
  status: 'draft' | 'published' | 'ongoing' | 'completed';
  startOffset: number;
  endOffset: number;
  deadlineOffset: number;
  isOnline: boolean;
  location: { venue: string; city: string; address: string };
  participantLimit: number;
  entryFee: number;
  prizePool: number | null;
  prizes: { ka: string; en: string; ru: string };
  rules: { ka: string; en: string; ru: string };
  isFeatured: boolean;
  coverImage: string;
  rounds: number;
  timeControl: { initialMinutes: number; incrementSeconds: number };
  requiresApproval: boolean;
}

const demoTournaments: SeedTournament[] = [
  {
    slug: 'tbilisi-open-2026',
    title: { ka: 'თბილისის ღია ჩემპიონატი 2026', en: 'Tbilisi Open 2026', ru: 'Тбилиси Опен 2026' },
    description: {
      ka: 'საქართველოს ერთ-ერთი ყველაზე მნიშვნელოვანი ღია საჭადრაკო ტურნირი. 9 ტური შვეიცარიული სისტემით, საერთაშორისო სტანდარტული დროის კონტროლით. მოწვეულნი არიან მოჭადრაკეები ყველა ასაკიდან და კატეგორიიდან.',
      en: 'One of Georgia’s flagship open chess events. Nine rounds of Swiss-system play with a classical time control. Players of all ages and categories are welcome.',
      ru: 'Один из главных открытых шахматных турниров Грузии. Девять туров по швейцарской системе с классическим контролем времени. Приглашаются шахматисты всех возрастов и категорий.',
    },
    tournamentType: 'classical',
    format: 'swiss',
    status: 'published',
    startOffset: 12,
    endOffset: 15,
    deadlineOffset: 8,
    isOnline: false,
    location: { venue: 'საჭადრაკო სასახლე', city: 'თბილისი', address: 'რუსთაველის გამზირი 5' },
    participantLimit: 64,
    entryFee: 50,
    prizePool: 3000,
    prizes: {
      ka: 'I ადგილი — 1200 ₾, II — 800 ₾, III — 500 ₾, საუკეთესო ქალი — 300 ₾, საუკეთესო U18 — 200 ₾',
      en: '1st place — 1200 GEL, 2nd — 800 GEL, 3rd — 500 GEL, best female — 300 GEL, best U18 — 200 GEL',
      ru: '1 место — 1200 ₾, 2 место — 800 ₾, 3 место — 500 ₾, лучшая женщина — 300 ₾, лучший U18 — 200 ₾',
    },
    rules: {
      ka: 'ტურნირი ტარდება FIDE-ის წესებით. დაყოვნება 30 წუთზე მეტი იწვევს ტექნიკურ წაგებას. მოთამაშეები ვალდებულნი არიან ჩაწერონ პარტიები. მობილური ტელეფონები უნდა იყოს გამორთული სათამაშო დარბაზში.',
      en: 'The tournament follows FIDE laws. Arriving more than 30 minutes late results in a forfeit. Players must record their games. Mobile phones must be switched off in the playing hall.',
      ru: 'Турнир проводится по правилам FIDE. Опоздание более чем на 30 минут ведёт к техническому поражению. Игроки обязаны записывать партии. Мобильные телефоны должны быть выключены в игровом зале.',
    },
    isFeatured: true,
    coverImage: '/images/tournaments/tbilisi-open.jpg',
    rounds: 9,
    timeControl: { initialMinutes: 90, incrementSeconds: 30 },
    requiresApproval: true,
  },
  {
    slug: 'georgian-rapid-championship',
    title: { ka: 'საქართველოს რაპიდის ჩემპიონატი', en: 'Georgian Rapid Championship', ru: 'Чемпионат Грузии по рапиду' },
    description: {
      ka: 'საქართველოს რაპიდის ჩემპიონატი 7 ტურით. სწრაფი დროის კონტროლი და ინტენსიური სათამაშო დღე - იდეალური შესაძლებლობა რეიტინგის ასამაღლებლად.',
      en: 'The national rapid championship over seven rounds. A fast time control and an intense playing day — the ideal opportunity to raise your rating.',
      ru: 'Чемпионат страны по рапиду из семи туров. Быстрый контроль времени и насыщенный игровой день — отличная возможность поднять рейтинг.',
    },
    tournamentType: 'rapid',
    format: 'swiss',
    status: 'published',
    startOffset: 5,
    endOffset: 5,
    deadlineOffset: 3,
    isOnline: false,
    location: { venue: 'სასტუმრო Rooms Hotel', city: 'თბილისი', address: 'კოსტავას ქუჩა 14' },
    participantLimit: 80,
    entryFee: 30,
    prizePool: 1500,
    prizes: {
      ka: 'საპრიზო ფონდი 1500 ₾. პირველი სამი ადგილი ფულადი პრიზებით, სპეციალური პრიზები ქალებისა და ახალგაზრდებისთვის.',
      en: 'A 1500 GEL prize fund. Cash prizes for the top three places and special prizes for women and juniors.',
      ru: 'Призовой фонд 1500 ₾. Денежные призы за первые три места и специальные призы для женщин и юниоров.',
    },
    rules: {
      ka: '7 ტური, 10+5 წუთი. ტურნირი გამართულია FIDE-ის რაპიდის წესებით. რეგისტრაცია იხურება საწყისამდე 48 საათით ადრე.',
      en: 'Seven rounds, 10+5 minutes. Played under FIDE rapid rules. Registration closes 48 hours before the start.',
      ru: 'Семь туров, 10+5 минут. Турнир проводится по правилам рапида FIDE. Регистрация закрывается за 48 часов до начала.',
    },
    isFeatured: true,
    coverImage: '/images/tournaments/rapid-championship.jpg',
    rounds: 7,
    timeControl: { initialMinutes: 10, incrementSeconds: 5 },
    requiresApproval: true,
  },
  {
    slug: 'online-blitz-arena',
    title: { ka: 'ონლაინ ბლიც არენა', en: 'Online Blitz Arena', ru: 'Онлайн блиц-арена' },
    description: {
      ka: 'ყოველკვირეული ონლაინ ბლიც ტურნირი 11 ტურით. ითამაშე სახლიდან, შეამოწმე ტაქტიკა და მოიპოვე არენის ტიტული. უფასო რეგისტრაცია.',
      en: 'A weekly online blitz arena with eleven rounds. Play from home, sharpen your tactics and claim the arena title. Free entry.',
      ru: 'Еженедельная онлайн блиц-арена из одиннадцати туров. Играйте из дома, тренируйте тактику и завоюйте титул арены. Участие бесплатное.',
    },
    tournamentType: 'blitz',
    format: 'swiss',
    status: 'published',
    startOffset: 2,
    endOffset: 2,
    deadlineOffset: 1,
    isOnline: true,
    location: { venue: 'Chess.com', city: 'ონლაინ', address: '' },
    participantLimit: 128,
    entryFee: 0,
    prizePool: 500,
    prizes: {
      ka: 'საპრიზო ფონდი 500 ₾, დამატებით Chess.com-ის პრემიუმ გამოწერები ტოპ-10 მოთამაშისთვის.',
      en: 'A 500 GEL prize fund plus Chess.com premium subscriptions for the top ten players.',
      ru: 'Призовой фонд 500 ₾ плюс премиум-подписки Chess.com для десяти лучших игроков.',
    },
    rules: {
      ka: '11 ტური, 5+3 წუთი. ლინკი გაიგზავნება რეგისტრაციის დადასტურების შემდეგ. Fair play წესები სავალდებულოა.',
      en: 'Eleven rounds at 5+3. The arena link is sent after registration approval. Fair-play rules apply.',
      ru: 'Одиннадцать туров 5+3. Ссылка на арену отправляется после подтверждения регистрации. Действуют правила fair play.',
    },
    isFeatured: true,
    coverImage: '/images/tournaments/online-blitz.jpg',
    rounds: 11,
    timeControl: { initialMinutes: 5, incrementSeconds: 3 },
    requiresApproval: false,
  },
  {
    slug: 'junior-chess-cup',
    title: { ka: 'ახალგაზრდული ჭადრაკის თასი', en: 'Junior Chess Cup', ru: 'Кубок юных шахматистов' },
    description: {
      ka: 'U16 ასაკის მოჭადრაკეებისთვის განკუთვნილი თასი. ტურნირი ხელს უწყობს ახალგაზრდების განვითარებას და აძლევს მათ შეჯიბრებით გამოცდილებას.',
      en: 'A cup dedicated to players under 16. The event supports young talent and gives juniors valuable competitive experience.',
      ru: 'Кубок для шахматистов до 16 лет. Турнир поддерживает молодые таланты и даёт юниорам ценный соревновательный опыт.',
    },
    tournamentType: 'rapid',
    format: 'swiss',
    status: 'published',
    startOffset: 20,
    endOffset: 21,
    deadlineOffset: 15,
    isOnline: false,
    location: { venue: 'საბავშვო ჭადრაკის ცენტრი', city: 'ბათუმი', address: 'ჭავჭავაძის ქუჩა 32' },
    participantLimit: 40,
    entryFee: 20,
    prizePool: 800,
    prizes: {
      ka: 'მედლები და დიპლომები ყველა მონაწილესთვის. საპრიზო ფონდი 800 ₾ სამ ასაკობრივ კატეგორიაში.',
      en: 'Medals and diplomas for every participant. An 800 GEL prize fund across three age categories.',
      ru: 'Медали и дипломы каждому участнику. Призовой фонд 800 ₾ в трёх возрастных категориях.',
    },
    rules: {
      ka: 'მონაწილეობა უფასოა U16 მოჭადრაკეებისთვის. საჭიროა დაბადების თარიღის დამადასტურებელი დოკუმენტი. 7 ტური, 15+10 წუთი.',
      en: 'Entry is free for U16 players. A document confirming the date of birth is required. Seven rounds at 15+10.',
      ru: 'Для игроков до 16 лет участие бесплатное. Требуется документ, подтверждающий дату рождения. Семь туров 15+10.',
    },
    isFeatured: false,
    coverImage: '/images/tournaments/junior-cup.jpg',
    rounds: 7,
    timeControl: { initialMinutes: 15, incrementSeconds: 10 },
    requiresApproval: true,
  },
  {
    slug: 'autumn-masters-2026',
    title: { ka: 'შემოდგომის მაგისტრები 2026', en: 'Autumn Masters 2026', ru: 'Осенние мастера 2026' },
    description: {
      ka: 'მიმდინარე ინტენსიური ტურნირი მოწვეული მოჭადრაკეებისთვის. 7 ტური, კლასიკური კონტროლი და მაღალი კონკურენცია.',
      en: 'An ongoing invitational event with seven rounds, a classical control and fierce competition.',
      ru: 'Продолжающийся турнир по приглашениям: семь туров, классический контроль и высокая конкуренция.',
    },
    tournamentType: 'classical',
    format: 'swiss',
    status: 'ongoing',
    startOffset: -1,
    endOffset: 2,
    deadlineOffset: -3,
    isOnline: false,
    location: { venue: 'ჭადრაკის ეროვნული ცენტრი', city: 'თბილისი', address: 'პეკინის გამზირი 22' },
    participantLimit: 16,
    entryFee: 100,
    prizePool: 5000,
    prizes: { ka: 'საპრიზო ფონდი 5000 ₾', en: 'A 5000 GEL prize fund', ru: 'Призовой фонд 5000 ₾' },
    rules: { ka: 'მოწვეული მოჭადრაკეები, 7 ტური, 90+30 წუთი.', en: 'Invited players only, seven rounds at 90+30.', ru: 'Только по приглашениям, семь туров 90+30.' },
    isFeatured: false,
    coverImage: '/images/tournaments/autumn-masters.jpg',
    rounds: 7,
    timeControl: { initialMinutes: 90, incrementSeconds: 30 },
    requiresApproval: false,
  },
  {
    slug: 'winter-classic-2025',
    title: { ka: 'ზამთრის კლასიკა 2025', en: 'Winter Classic 2025', ru: 'Зимняя классика 2025' },
    description: {
      ka: 'დასრულებული კლასიკური ტურნირი, რომელმაც გააერთიანა 24 მოჭადრაკე. საუკეთესო შედეგი აჩვენა ილია სულაბერიძემ.',
      en: 'A completed classical event that brought together 24 players. Ilia Sulaberidze finished on top.',
      ru: 'Завершённый классический турнир, объединивший 24 шахматиста. Лучший результат показал Илья Сулаберидзе.',
    },
    tournamentType: 'classical',
    format: 'swiss',
    status: 'completed',
    startOffset: -24,
    endOffset: -22,
    deadlineOffset: -30,
    isOnline: false,
    location: { venue: 'ჭადრაკის სასახლე', city: 'თბილისი', address: 'რუსთაველის გამზირი 5' },
    participantLimit: 32,
    entryFee: 40,
    prizePool: 2000,
    prizes: { ka: 'საპრიზო ფონდი 2000 ₾', en: 'A 2000 GEL prize fund', ru: 'Призовой фонд 2000 ₾' },
    rules: { ka: '9 ტური, 90+30 წუთი, FIDE-ის წესები.', en: 'Nine rounds at 90+30 under FIDE rules.', ru: 'Девять туров 90+30 по правилам FIDE.' },
    isFeatured: false,
    coverImage: '/images/tournaments/winter-classic.jpg',
    rounds: 9,
    timeControl: { initialMinutes: 90, incrementSeconds: 30 },
    requiresApproval: false,
  },
  {
    slug: 'spring-cup-draft',
    title: { ka: 'გაზაფხულის თასი (მონახაზი)', en: 'Spring Cup (draft)', ru: 'Весенний кубок (черновик)' },
    description: {
      ka: 'მომავალი ტურნირის მონახაზი. დეტალები დაზუსტების პროცესშია.',
      en: 'Draft of an upcoming tournament. Details are being finalised.',
      ru: 'Черновик предстоящего турнира. Детали уточняются.',
    },
    tournamentType: 'rapid',
    format: 'swiss',
    status: 'draft',
    startOffset: 45,
    endOffset: 45,
    deadlineOffset: 40,
    isOnline: false,
    location: { venue: 'საჭადრაკო კლუბი 64', city: 'თბილისი', address: 'ვაჟა-ფშაველას გამზირი 41' },
    participantLimit: 48,
    entryFee: 25,
    prizePool: null,
    prizes: { ka: '', en: '', ru: '' },
    rules: { ka: '', en: '', ru: '' },
    isFeatured: false,
    coverImage: '/images/tournaments/junior-cup.jpg',
    rounds: 7,
    timeControl: { initialMinutes: 10, incrementSeconds: 5 },
    requiresApproval: true,
  },
];

async function ensureTournament(organizerId: string, categoryId: string, item: SeedTournament) {
  const existing = await Tournament.findOne({ slug: item.slug });
  if (existing) {
    return existing;
  }
  return Tournament.create({
    title: item.title,
    slug: item.slug,
    description: item.description,
    categoryId,
    organizerId,
    coverImage: { url: item.coverImage, publicId: '' },
    tournamentType: item.tournamentType,
    format: item.format,
    status: item.status,
    startDate: date(item.startOffset, 10),
    endDate: date(item.endOffset, 18),
    registrationDeadline: date(item.deadlineOffset, 23),
    location: item.location,
    isOnline: item.isOnline,
    participantLimit: item.participantLimit,
    currentParticipants: 0,
    entryFee: item.entryFee,
    currency: 'GEL',
    prizePool: item.prizePool,
    prizes: item.prizes,
    rules: item.rules,
    contact: { name: 'ორგანიზატორი', email: 'organizer@arena.ge', phone: '+995 322 000 000' },
    gameSettings: { timeControl: item.timeControl, rounds: item.rounds },
    registrationSettings: {
      requiresApproval: item.requiresApproval,
      allowGuestRegistration: true,
      allowWaitlist: true,
      allowSelfCancellation: true,
    },
    isFeatured: item.isFeatured,
    publishedAt: item.status === 'draft' ? null : date(item.deadlineOffset - 5, 12),
  });
}

async function seedRegistrations(tournamentsBySlug: Map<string, InstanceType<typeof Tournament>>, participantUserId: string) {
  const plans: { slug: string; statuses: RegistrationStatus[] }[] = [
    { slug: 'tbilisi-open-2026', statuses: ['approved', 'approved', 'approved', 'pending', 'pending', 'waitlisted', 'approved'] },
    { slug: 'georgian-rapid-championship', statuses: ['approved', 'pending', 'approved', 'approved'] },
    { slug: 'online-blitz-arena', statuses: ['approved', 'approved', 'approved'] },
    { slug: 'autumn-masters-2026', statuses: ['approved', 'approved', 'approved', 'approved', 'approved', 'approved', 'approved', 'approved', 'approved', 'approved'] },
    { slug: 'winter-classic-2025', statuses: ['approved', 'approved', 'approved', 'approved', 'approved', 'approved', 'approved', 'rejected', 'cancelled'] },
  ];

  let counter = 0;
  for (const plan of plans) {
    const tournament = tournamentsBySlug.get(plan.slug);
    if (!tournament) {
      continue;
    }
    if ((await Registration.countDocuments({ tournamentId: tournament._id })) > 0) {
      continue;
    }
    let seatCount = 0;
    for (let index = 0; index < plan.statuses.length; index += 1) {
      const status = plan.statuses[index];
      const person = demoParticipants[counter % demoParticipants.length];
      counter += 1;
      const linkedUserId = index === 0 && plan.slug === 'tbilisi-open-2026' ? participantUserId : undefined;
      const email = index === 0 && plan.slug === 'tbilisi-open-2026'
        ? 'participant@arena.ge'
        : `${plan.slug}.${index}.${person.email}`;
      await Registration.create({
        tournamentId: tournament._id,
        userId: linkedUserId ?? null,
        participantInformation: {
          firstName: person.firstName,
          lastName: person.lastName,
          email,
          phone: person.phone,
          fideId: '',
          rating: person.rating,
          club: person.club,
          notes: '',
          customFields: {},
        },
        status,
        registrationNumber: `CHS-${new Date().getFullYear()}-${(1000 + counter).toString()}`,
        reviewedBy: status === 'rejected' ? tournament.organizerId : null,
        reviewedAt: status === 'rejected' ? new Date() : null,
      });
      if (status === 'pending' || status === 'approved') {
        seatCount += 1;
      }
    }
    tournament.currentParticipants = seatCount;
    await tournament.save();
  }
}

async function main(): Promise<void> {
  await connectDatabase();
  await initModels();

  if (
    env.isProduction &&
    (env.seed.adminPassword === 'Admin123!' || env.seed.organizerPassword === 'Organizer123!')
  ) {
    throw new Error(
      'Set SEED_ADMIN_PASSWORD and SEED_ORGANIZER_PASSWORD to strong non-default values before bootstrapping production',
    );
  }

  const admin = await ensureUser({
    email: env.seed.adminEmail,
    password: env.seed.adminPassword,
    firstName: 'ნინო',
    lastName: 'ადმინისტრატორი',
    role: 'super_admin',
  });

  const category = await ensureChessCategory();

  await Setting.findOneAndUpdate(
    { key: 'platform' },
    {
      $setOnInsert: {
        key: 'platform',
        siteName: { ka: 'ჭადრაკის არენა', en: 'Chess Arena', ru: 'Шахматная арена' },
        tagline: {
          ka: 'ერთი პლატფორმა ყველა ტურნირისთვის',
          en: 'One platform for every tournament',
          ru: 'Одна платформа для всех турниров',
        },
        contactEmail: 'hello@arena.ge',
        socialLinks: { facebook: 'https://facebook.com', instagram: 'https://instagram.com', youtube: 'https://youtube.com' },
      },
    },
    { upsert: true, new: true },
  );

  if (env.isProduction) {
    console.log('\nProduction bootstrap complete.');
    console.log(`  Super admin: ${env.seed.adminEmail}`);
    console.log('  Demo organizer, participant, tournaments and registrations were skipped.');
    console.log(`  Admin id: ${admin._id.toString()}`);
    await disconnectDatabase();
    return;
  }

  const organizer = await ensureUser({
    email: env.seed.organizerEmail,
    password: env.seed.organizerPassword,
    firstName: 'ლევან',
    lastName: 'ორგანიზატორი',
    role: 'admin',
  });
  const participant = await ensureUser({
    email: 'participant@arena.ge',
    password: 'Participant123!',
    firstName: 'ლუკა',
    lastName: 'ბერიძე',
    role: 'participant',
  });

  const tournamentsBySlug = new Map<string, InstanceType<typeof Tournament>>();
  for (const item of demoTournaments) {
    const tournament = await ensureTournament(organizer._id.toString(), category._id.toString(), item);
    tournamentsBySlug.set(item.slug, tournament);
  }

  await seedRegistrations(tournamentsBySlug, participant._id.toString());

  console.log('\nSeed complete.');
  console.log(`  Super admin: ${env.seed.adminEmail} / ${env.seed.adminPassword}`);
  console.log(`  Organizer:   ${env.seed.organizerEmail} / ${env.seed.organizerPassword}`);
  console.log('  Participant: participant@arena.ge / Participant123!');
  console.log(`  Admin id: ${admin._id.toString()}`);

  await disconnectDatabase();
}

main().catch(async (error) => {
  console.error('Seed failed:', error);
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
});
